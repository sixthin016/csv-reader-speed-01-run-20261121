// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly the answer
// csv-reader returns for {text, header} — {columns, rows, errors} — but reads
// the text with bulk scans (indexOf / slice / split) instead of one character
// at a time.
//
// The reading policy, restated from the reference so this file stands alone:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote and each CRLF or lone CR inside it reads as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (error quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with
//     empty strings (short_row, with fields: its field count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based line
//     its record starts on (counting every LF, CRLF and lone CR inside quotes),
//     row its record's index in rows (null for the header).
//
// Speed shape: a record is read run by run. Each run of plain fields up to
// the next quoted field is split on commas in one C++ pass, and a record with
// no quote in it at all is split the same way. Only quoted fields, lines with
// a stray CR, and quotes sitting inside an unquoted field are read field by
// field — there each unquoted field is found with one regex scan and each
// quoted field by searching for its closing quote, so the common clean quoted
// field is a single slice. Only the rare segments that hold line breaks
// inside quotes, doubled quotes, or stray CRs are walked character by
// character.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break or 2 at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field scanned ended, and how many characters its unquoted
  // scan kept (the junk check reads this after a quoted field's tail).
  let ended = END;
  let addedOut = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets `ended` and
  // `addedOut` (the characters kept) and returns the field.
  const DELIM = /[,\r\n]/g;
  function scanUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (n > start) {
          value += text.slice(start, n);
          added += n - start;
        }
        pos = n;
        ended = END;
        addedOut = added;
        return value;
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > start) {
          value += text.slice(start, i);
          added += i - start;
        }
        pos = i + 1;
        ended = COMMA;
        addedOut = added;
        return value;
      }
      if (c === '\n') {
        // A CR just before it makes the break a CRLF.
        const e = i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
        if (e > start) {
          value += text.slice(start, e);
          added += e - start;
        }
        pos = i + 1;
        line += 1;
        ended = LINE_BREAK;
        addedOut = added;
        return value;
      }
      // A CR: a line break when LF follows it, else a stray CR to drop.
      if (text.charCodeAt(i + 1) === 10) {
        if (i > start) {
          value += text.slice(start, i);
          added += i - start;
        }
        pos = i + 2;
        line += 1;
        ended = LINE_BREAK;
        addedOut = added;
        return value;
      }
      error('stray_cr');
      if (i > start) {
        value += text.slice(start, i);
        added += i - start;
      }
      pos = i + 1;
      start = i + 1;
    }
  }

  // Appends text[a..b) to `value`, reading each CRLF or lone CR inside it as
  // one LF and counting the lines it crosses. A segment with no line break in
  // it is one slice.
  function appendSegment(value, a, b) {
    if (a >= b) return value;
    const nl = text.indexOf('\n', a);
    const cr = text.indexOf('\r', a);
    if ((nl === -1 || nl >= b) && (cr === -1 || cr >= b)) return value + text.slice(a, b);
    let out = value;
    let start = a;
    let i = a;
    while (i < b) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        out += text.slice(start, i);
        out += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        start = i;
      } else if (c === 10) {
        out += text.slice(start, i);
        out += '\n';
        line += 1;
        i += 1;
        start = i;
      } else {
        i += 1;
      }
    }
    return out + text.slice(start, b);
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended` and
  // returns the field.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let from = pos + 1;
    for (;;) {
      const q = text.indexOf('"', from);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return scanUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the scan goes on.
        value = appendSegment(value, from, q);
        value += '"';
        from = q + 2;
        continue;
      }
      // The closing quote.
      value = appendSegment(value, from, q);
      pos = q + 1;
      if (pos >= n) {
        ended = END;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = scanUnquoted(value);
      if (addedOut > 0) error('quote_junk');
      return junk;
    }
  }

  // Closes a record: drops it when it held no characters, else records it at
  // the first record's width, noting a short or long row.
  function finish(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads one field of the record being built, field by field. Used only
  // where a bulk split cannot: a stray CR, or a quote inside an unquoted field.
  function scanField(fields) {
    let field;
    let quoted;
    if (text.charCodeAt(pos) === 34) {
      quoted = true;
      field = scanQuoted();
    } else {
      quoted = false;
      field = scanUnquoted('');
    }
    fields.push(field);
    return quoted;
  }

  records: while (pos < n) {
    // Lines with no characters are no records.
    for (;;) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
      if (pos >= n) break records;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted = false;
    // A record is read run by run: each run of plain fields up to the next
    // quoted field is split on commas at once, and only the quoted fields
    // (and lines with a stray CR) are read field by field.
    for (;;) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? n : nl;
      const q = text.indexOf('"', pos);
      if (q === -1 || q >= lineEnd) {
        // The rest of the record is on this line and holds no quote.
        const cr = text.indexOf('\r', pos);
        if (cr === -1 || cr >= lineEnd) {
          const tail = text.slice(pos, lineEnd).split(',');
          for (let i = 0; i < tail.length; i++) fields.push(tail[i]);
          pos = nl === -1 ? n : nl + 1;
          line += 1;
          quoted = false;
          break;
        }
        if (cr === lineEnd - 1 && nl !== -1) {
          const tail = text.slice(pos, lineEnd - 1).split(',');
          for (let i = 0; i < tail.length; i++) fields.push(tail[i]);
          pos = nl + 1;
          line += 1;
          quoted = false;
          break;
        }
        // A stray CR sits in the rest of the line: read it field by field.
        for (;;) {
          quoted = scanField(fields);
          if (ended !== COMMA) break;
        }
        break;
      }
      if (q !== pos && text.charCodeAt(q - 1) !== 44) {
        // The quote sits inside an unquoted field, where it is literal:
        // read the rest of the record field by field.
        for (;;) {
          quoted = scanField(fields);
          if (ended !== COMMA) break;
        }
        break;
      }
      // The quote opens a field. The plain fields before it split at once,
      // unless a stray CR hides among them.
      if (q > pos) {
        const cr = text.indexOf('\r', pos);
        if (cr !== -1 && cr < q) {
          for (;;) {
            quoted = scanField(fields);
            if (ended !== COMMA) break;
          }
          break;
        }
        const head = text.slice(pos, q - 1).split(',');
        for (let i = 0; i < head.length; i++) fields.push(head[i]);
      }
      pos = q;
      quoted = true;
      fields.push(scanQuoted());
      if (ended !== COMMA) break;
    }
    finish(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---------------------------------------------------------------------------
// Fast path: parse the CSV text held, JSON-escaped, in a region of a string.
//
// runJson(src, a, b, header) reads the CSV text in src[a..b) — the content of
// one case's "text" JSON string, so a quote reads as \" and a line break as
// \n or \r — and returns the case's answer as a JSON string, {columns, rows,
// errors}, the JSON.stringify of what run() returns for the same unescaped
// text (keys in the same order). It never builds the answer's objects: each
// record's fields are emitted as JSON straight from the escaped slices, so the
// only strings it keeps are the output's own chunks. That is the whole point —
// the plain reader's cost is not the scan, it is the object graph it builds
// and the JSON.stringify that walks it again.
//
// The escaped slices copy verbatim because the generator's text holds no
// character that JSON escapes any other way: no backslash, no tab, no control
// character but LF/CR, no lone surrogate (see program/generator/subject/
// csv-cases.mjs). main.ts falls back to run() when the file holds an escape
// outside \" \n \r, so this path never reads such a file.
// ---------------------------------------------------------------------------

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const F_COMMA = 0;
const F_LINE_BREAK = 1;
const F_END = 2;

/** The case's answer as a JSON string, read from the unescaped CSV text. */
export function runEmit(text, header) {
  const n = text.length;
  const rowsOut = []; // record JSON strings
  const errOut = []; // error JSON strings
  let columnsJson = null; // the first record's JSON, or null
  let width = -1;
  let rowsCount = 0;
  let line = 1; // the line the next character is on
  let pos = 0; // the next character to read
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let ended = F_END;
  let addedOut = 0; // characters the last unquoted scan kept
  let recordLine = 1;
  let recordRow = null;

  function errJson(code, extra) {
    return (
      '{"code":"' +
      code +
      '","line":' +
      recordLine +
      ',"row":' +
      (recordRow === null ? 'null' : recordRow) +
      (extra || '') +
      '}'
    );
  }

  // Appends text[x..y) to `value`, reading each CRLF or lone CR inside it as
  // one LF and counting the lines it crosses. A segment with no line break in
  // it is one slice.
  function appendSegment(value, x, y) {
    if (x >= y) return value;
    const nl = text.indexOf('\n', x);
    if (nl !== -1 && nl < y) {
      const parts = text.slice(x, y).split(/\r\n|\r|\n/);
      line += parts.length - 1;
      return value + parts.join('\n');
    }
    const cr = text.indexOf('\r', x);
    if (cr !== -1 && cr < y) {
      const parts = text.slice(x, y).split(/\r\n|\r|\n/);
      line += parts.length - 1;
      return value + parts.join('\n');
    }
    return value + text.slice(x, y);
  }

  // Reads unquoted characters onto `init` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets `ended` and
  // `addedOut` (the characters kept) and returns the field's JSON.
  // The field's content is JSON-escaped on the fly: a plain segment is copied
  // verbatim when it holds no character JSON escapes, else escaped field by
  // field through JSON.stringify on the segment (rare: only a quote, a
  // backslash or a control character forces it).
  const NEED_ESCAPE = /["\\\x00-\x1f]/;
  const DELIM2 = /[,\r\n]/g;
  function escSeg(seg) {
    return NEED_ESCAPE.test(seg) ? JSON.stringify(seg).slice(1, -1) : seg;
  }

  function scanUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    for (;;) {
      DELIM2.lastIndex = pos;
      const m = DELIM2.exec(text);
      if (m === null) {
        if (n > start) {
          value += escSeg(text.slice(start, n));
          added += n - start;
        }
        pos = n;
        ended = F_END;
        addedOut = added;
        return '"' + value + '"';
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > start) {
          value += escSeg(text.slice(start, i));
          added += i - start;
        }
        pos = i + 1;
        ended = F_COMMA;
        addedOut = added;
        return '"' + value + '"';
      }
      if (c === '\n') {
        const e = i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
        if (e > start) {
          value += escSeg(text.slice(start, e));
          added += e - start;
        }
        pos = i + 1;
        line += 1;
        ended = F_LINE_BREAK;
        addedOut = added;
        return '"' + value + '"';
      }
      // A CR: a line break when LF follows it, else a stray CR to drop.
      if (text.charCodeAt(i + 1) === 10) {
        if (i > start) {
          value += escSeg(text.slice(start, i));
          added += i - start;
        }
        pos = i + 2;
        line += 1;
        ended = F_LINE_BREAK;
        addedOut = added;
        return '"' + value + '"';
      }
      errOut.push(errJson('stray_cr'));
      if (i > start) {
        value += escSeg(text.slice(start, i));
        added += i - start;
      }
      pos = i + 1;
      start = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended` and
  // returns the field's JSON.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let from = pos + 1;
    for (;;) {
      const q = text.indexOf('"', from);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errOut.push(errJson('unterminated_quote'));
        return scanUnquoted('\\"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the scan goes on.
        value = appendSegment(value, from, q);
        value += '"';
        from = q + 2;
        continue;
      }
      // The closing quote.
      value = appendSegment(value, from, q);
      pos = q + 1;
      if (pos >= n) {
        ended = F_END;
        return '"' + escSeg(value) + '"';
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = F_COMMA;
        return '"' + escSeg(value) + '"';
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = F_LINE_BREAK;
        return '"' + escSeg(value) + '"';
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = F_LINE_BREAK;
        return '"' + escSeg(value) + '"';
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = scanUnquoted(escSeg(value));
      if (addedOut > 0) errOut.push(errJson('quote_junk'));
      return junk;
    }
  }

  // Reads one field of the record being built, field by field. Used only
  // where a bulk split cannot: a stray CR, or a quote inside an unquoted field.
  function scanField(fields) {
    let field;
    let quoted;
    if (text.charCodeAt(pos) === 34) {
      quoted = true;
      field = scanQuoted();
    } else {
      quoted = false;
      field = scanUnquoted('');
    }
    fields.push(field);
    return quoted;
  }

  records: while (pos < n) {
    // Lines with no characters are no records.
    for (;;) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
      if (pos >= n) break records;
    }

    recordLine = line;
    recordRow = header && columnsJson === null ? null : rowsCount;

    const fields = [];
    let lastQuoted = false;
    // A record is read run by run: each run of plain fields up to the next
    // quoted field is split on commas at once, and only the quoted fields
    // (and lines with a stray CR) are read field by field.
    for (;;) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? n : nl;
      const q = text.indexOf('"', pos);
      if (q === -1 || q >= lineEnd) {
        // The rest of the record is on this line and holds no quote.
        const cr = text.indexOf('\r', pos);
        if (cr === -1 || cr >= lineEnd) {
          const tail = text.slice(pos, lineEnd);
          if (nl === -1) pos = n;
          else {
            pos = nl + 1;
            line += 1;
          }
          const parts = tail.split(',');
          for (let i = 0; i < parts.length; i++) fields.push('"' + escSeg(parts[i]) + '"');
          lastQuoted = false;
          break;
        }
        if (cr === lineEnd - 1 && nl !== -1) {
          const tail = text.slice(pos, lineEnd - 1);
          pos = nl + 1;
          line += 1;
          const parts = tail.split(',');
          for (let i = 0; i < parts.length; i++) fields.push('"' + escSeg(parts[i]) + '"');
          lastQuoted = false;
          break;
        }
        // A stray CR sits in the rest of the line: read it field by field.
        for (;;) {
          lastQuoted = scanField(fields);
          if (ended !== F_COMMA) break;
        }
        break;
      }
      if (q !== pos && text.charCodeAt(q - 1) !== 44) {
        // The quote sits inside an unquoted field, where it is literal:
        // read the rest of the record field by field.
        for (;;) {
          lastQuoted = scanField(fields);
          if (ended !== F_COMMA) break;
        }
        break;
      }
      // The quote opens a field. The plain fields before it split at once,
      // unless a stray CR hides among them.
      if (q > pos) {
        const cr = text.indexOf('\r', pos);
        if (cr !== -1 && cr < q) {
          for (;;) {
            lastQuoted = scanField(fields);
            if (ended !== F_COMMA) break;
          }
          break;
        }
        const head = text.slice(pos, q - 1).split(',');
        for (let i = 0; i < head.length; i++) fields.push('"' + escSeg(head[i]) + '"');
      }
      pos = q;
      lastQuoted = true;
      fields.push(scanQuoted());
      if (ended !== F_COMMA) break;
    }

    // Closes a record: drops it when it held no characters, else records it at
    // the first record's width, noting a short or long row.
    if (fields.length === 1 && fields[0] === '""' && !lastQuoted) continue;
    if (width < 0) width = fields.length;
    if (header && columnsJson === null) {
      columnsJson = '[' + fields.join(',') + ']';
      continue;
    }
    if (fields.length < width) {
      errOut.push(
        '{"code":"short_row","line":' +
          recordLine +
          ',"row":' +
          (recordRow === null ? 'null' : recordRow) +
          ',"fields":' +
          fields.length +
          '}'
      );
      while (fields.length < width) fields.push('""');
    } else if (fields.length > width) {
      const extra = fields.splice(width);
      errOut.push(
        '{"code":"long_row","line":' +
          recordLine +
          ',"row":' +
          (recordRow === null ? 'null' : recordRow) +
          ',"extra":[' +
          extra.join(',') +
          ']}'
      );
    }
    rowsOut.push('[' + fields.join(',') + ']');
    rowsCount += 1;
  }

  return (
    '{"columns":' +
    (header ? (columnsJson ?? '[]') : 'null') +
    ',"rows":[' +
    rowsOut.join(',') +
    '],"errors":[' +
    errOut.join(',') +
    ']}'
  );
}


/** The case's answer as a JSON string, read from the JSON-escaped CSV text in src[a..b). */
export function runJson(src, a, b, header) {
  const rowsOut = []; // record JSON strings
  const errOut = []; // error JSON strings
  let columnsJson = null; // the first record's JSON, or null
  let width = -1;
  let rowsCount = 0;
  let line = 1; // the line the next character is on
  let pos = a; // the next character to read
  if (pos < b && src.charCodeAt(pos) === 0xfeff) pos = a + 1;

  let ended = F_END;
  let addedOut = 0; // escaped characters the last unquoted scan kept
  let recordLine = 1;
  let recordRow = null;

  function errJson(code, extra) {
    return (
      '{"code":"' +
      code +
      '","line":' +
      recordLine +
      ',"row":' +
      (recordRow === null ? 'null' : recordRow) +
      (extra || '') +
      '}'
    );
  }

  // Appends the escaped segment src[x..y) to `value`, reading each \r\n or
  // lone \r inside it as one \n and counting the lines it crosses. A segment
  // with no line break in it is one slice.
  function appendSegment(value, x, y) {
    if (x >= y) return value;
    const nl = src.indexOf('\\n', x);
    if (nl !== -1 && nl < y) {
      const seg = src.slice(x, y);
      const parts = seg.split(/\\r\\n|\\r|\\n/);
      line += parts.length - 1;
      return value + parts.join('\\n');
    }
    const cr = src.indexOf('\\r', x);
    if (cr !== -1 && cr < y) {
      const seg = src.slice(x, y);
      const parts = seg.split(/\\r\\n|\\r|\\n/);
      line += parts.length - 1;
      return value + parts.join('\\n');
    }
    return value + src.slice(x, y);
  }

  // Reads unquoted characters onto `init` up to the next comma or line break:
  // a \r not followed by \n is dropped (stray_cr). Sets `ended` and
  // `addedOut` (the escaped characters kept) and returns the field's JSON.
  function scanUnquoted(init) {
    let value = init;
    let added = 0;
    let start = pos;
    for (;;) {
      const comma = src.indexOf(',', pos);
      const nl = src.indexOf('\\n', pos);
      const cr = src.indexOf('\\r', pos);
      let i = -1;
      let kind = 0; // 0 comma, 1 \n, 2 \r
      if (comma !== -1 && comma < b && (i === -1 || comma < i)) {
        i = comma;
        kind = 0;
      }
      if (nl !== -1 && nl < b && (i === -1 || nl < i)) {
        i = nl;
        kind = 1;
      }
      if (cr !== -1 && cr < b && (i === -1 || cr < i)) {
        i = cr;
        kind = 2;
      }
      if (i === -1) {
        if (b > start) {
          value += src.slice(start, b);
          added += b - start;
        }
        pos = b;
        ended = F_END;
        addedOut = added;
        return '"' + value + '"';
      }
      if (kind === 0) {
        if (i > start) {
          value += src.slice(start, i);
          added += i - start;
        }
        pos = i + 1;
        ended = F_COMMA;
        addedOut = added;
        return '"' + value + '"';
      }
      if (kind === 1) {
        // A \r just before it makes the break a CRLF.
        const e = i >= start + 2 && src.charCodeAt(i - 2) === 92 && src.charCodeAt(i - 1) === 114 ? i - 2 : i;
        if (e > start) {
          value += src.slice(start, e);
          added += e - start;
        }
        pos = i + 2;
        line += 1;
        ended = F_LINE_BREAK;
        addedOut = added;
        return '"' + value + '"';
      }
      // A \r: a line break when \n follows it, else a stray CR to drop.
      if (src.charCodeAt(i + 2) === 92 && src.charCodeAt(i + 3) === 110) {
        if (i > start) {
          value += src.slice(start, i);
          added += i - start;
        }
        pos = i + 4;
        line += 1;
        ended = F_LINE_BREAK;
        addedOut = added;
        return '"' + value + '"';
      }
      errOut.push(errJson('stray_cr'));
      if (i > start) {
        value += src.slice(start, i);
        added += i - start;
      }
      pos = i + 2;
      start = i + 2;
    }
  }

  // Reads a quoted field whose opening \" is at pos. Sets `ended` and returns
  // the field's JSON.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let from = pos + 2;
    for (;;) {
      const q = src.indexOf('\\"', from);
      if (q === -1 || q >= b) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 2;
        line = openLine;
        errOut.push(errJson('unterminated_quote'));
        return scanUnquoted('\\"');
      }
      if (src.charCodeAt(q + 2) === 92 && src.charCodeAt(q + 3) === 34) {
        // A doubled quote: one quote in the value, and the scan goes on.
        value = appendSegment(value, from, q);
        value += '\\"';
        from = q + 4;
        continue;
      }
      // The closing quote.
      value = appendSegment(value, from, q);
      pos = q + 2;
      if (pos >= b) {
        ended = F_END;
        return '"' + value + '"';
      }
      if (src.charCodeAt(pos) === 44) {
        pos += 1;
        ended = F_COMMA;
        return '"' + value + '"';
      }
      if (src.charCodeAt(pos) === 92 && src.charCodeAt(pos + 1) === 110) {
        pos += 2;
        line += 1;
        ended = F_LINE_BREAK;
        return '"' + value + '"';
      }
      if (
        src.charCodeAt(pos) === 92 &&
        src.charCodeAt(pos + 1) === 114 &&
        src.charCodeAt(pos + 2) === 92 &&
        src.charCodeAt(pos + 3) === 110
      ) {
        pos += 4;
        line += 1;
        ended = F_LINE_BREAK;
        return '"' + value + '"';
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = scanUnquoted(value);
      if (addedOut > 0) errOut.push(errJson('quote_junk'));
      return junk;
    }
  }

  // Reads one field of the record being built, field by field. Used only
  // where a bulk split cannot: a stray CR, or a quote inside an unquoted field.
  function scanField(fields) {
    let field;
    let quoted;
    if (src.charCodeAt(pos) === 92 && src.charCodeAt(pos + 1) === 34) {
      quoted = true;
      field = scanQuoted();
    } else {
      quoted = false;
      field = scanUnquoted('');
    }
    fields.push(field);
    return quoted;
  }

  records: while (pos < b) {
    // Lines with no characters are no records.
    for (;;) {
      if (src.charCodeAt(pos) === 92 && src.charCodeAt(pos + 1) === 110) {
        pos += 2;
        line += 1;
      } else if (
        src.charCodeAt(pos) === 92 &&
        src.charCodeAt(pos + 1) === 114 &&
        src.charCodeAt(pos + 2) === 92 &&
        src.charCodeAt(pos + 3) === 110
      ) {
        pos += 4;
        line += 1;
      } else {
        break;
      }
      if (pos >= b) break records;
    }

    recordLine = line;
    recordRow = header && columnsJson === null ? null : rowsCount;

    const fields = [];
    let lastQuoted = false;
    // A record is read run by run: each run of plain fields up to the next
    // quoted field is split on commas at once, and only the quoted fields
    // (and lines with a stray CR) are read field by field.
    for (;;) {
      const nl = src.indexOf('\\n', pos);
      const lineEnd = nl === -1 ? b : nl;
      const q = src.indexOf('\\"', pos);
      if (q === -1 || q >= lineEnd) {
        // The rest of the record is on this line and holds no quote.
        const cr = src.indexOf('\\r', pos);
        if (cr === -1 || cr >= lineEnd) {
          const tail = nl === -1 ? src.slice(pos, b) : src.slice(pos, lineEnd);
          if (nl === -1) pos = b;
          else {
            pos = nl + 2;
            line += 1;
          }
          const parts = tail.split(',');
          for (let i = 0; i < parts.length; i++) fields.push('"' + parts[i] + '"');
          lastQuoted = false;
          break;
        }
        if (cr === lineEnd - 2 && nl !== -1) {
          const tail = src.slice(pos, lineEnd - 2);
          pos = nl + 2;
          line += 1;
          const parts = tail.split(',');
          for (let i = 0; i < parts.length; i++) fields.push('"' + parts[i] + '"');
          lastQuoted = false;
          break;
        }
        // A stray CR sits in the rest of the line: read it field by field.
        for (;;) {
          lastQuoted = scanField(fields);
          if (ended !== F_COMMA) break;
        }
        break;
      }
      if (q !== pos && src.charCodeAt(q - 1) !== 44) {
        // The quote sits inside an unquoted field, where it is literal:
        // read the rest of the record field by field.
        for (;;) {
          lastQuoted = scanField(fields);
          if (ended !== F_COMMA) break;
        }
        break;
      }
      // The quote opens a field. The plain fields before it split at once,
      // unless a stray CR hides among them.
      if (q > pos) {
        const cr = src.indexOf('\\r', pos);
        if (cr !== -1 && cr < q) {
          for (;;) {
            lastQuoted = scanField(fields);
            if (ended !== F_COMMA) break;
          }
          break;
        }
        const head = src.slice(pos, q - 1).split(',');
        for (let i = 0; i < head.length; i++) fields.push('"' + head[i] + '"');
      }
      pos = q;
      lastQuoted = true;
      fields.push(scanQuoted());
      if (ended !== F_COMMA) break;
    }

    // Closes a record: drops it when it held no characters, else records it at
    // the first record's width, noting a short or long row.
    if (fields.length === 1 && fields[0] === '""' && !lastQuoted) continue;
    if (width < 0) width = fields.length;
    if (header && columnsJson === null) {
      columnsJson = '[' + fields.join(',') + ']';
      continue;
    }
    if (fields.length < width) {
      errOut.push(
        '{"code":"short_row","line":' +
          recordLine +
          ',"row":' +
          (recordRow === null ? 'null' : recordRow) +
          ',"fields":' +
          fields.length +
          '}'
      );
      while (fields.length < width) fields.push('""');
    } else if (fields.length > width) {
      const extra = fields.splice(width);
      errOut.push(
        '{"code":"long_row","line":' +
          recordLine +
          ',"row":' +
          (recordRow === null ? 'null' : recordRow) +
          ',"extra":[' +
          extra.join(',') +
          ']}'
      );
    }
    rowsOut.push('[' + fields.join(',') + ']');
    rowsCount += 1;
  }

  return (
    '{"columns":' +
    (header ? (columnsJson ?? '[]') : 'null') +
    ',"rows":[' +
    rowsOut.join(',') +
    '],"errors":[' +
    errOut.join(',') +
    ']}'
  );
}

