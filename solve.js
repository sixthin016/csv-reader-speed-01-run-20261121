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
