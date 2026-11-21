// A byte-level CSV reader for the csv-reader-speed competition, compiled to
// WebAssembly. It answers one case: given the case's "text" JSON string
// (still escaped, as it sits in cases.json), it unescapes it, parses the CSV
// with exactly the semantics of solve.js run(), and writes the case's answer
// as JSON — {"columns","rows","errors"} — into the output buffer.
//
// Why bytes: the CSV structure (comma, quote, CR, LF) is ASCII, and the JSON
// escapes a field needs (" \ and control characters) are ASCII too, so a
// UTF-8 field can be copied verbatim except for those bytes. Working on
// bytes keeps the parser allocation-free: a record's field values are built
// once in a scratch arena, and the answer is emitted straight into the
// output buffer — no object graph, no JSON.stringify, no per-field string.
//
// The driver (main.ts) copies each case's escaped "text" token into the
// token buffer, calls parse_case, and reads the answer from the output
// buffer. parse_case returns 0 when the token holds an escape this reader
// does not handle, and the driver then falls back to the plain JS reader.

use memchr::{memchr, memchr3};

/// How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text.
const COMMA: u8 = 0;
const LINE_BREAK: u8 = 1;
const END: u8 = 2;

/// One parse error, in the shape run() reports it.
struct Error {
    code: &'static str,
    line: usize,
    row: Option<usize>,
    /// short_row: the record's field count.
    fields: Option<usize>,
    /// long_row: the extra field values, copied out of the arena.
    extra: Vec<Vec<u8>>,
}

/// Appends s as a JSON string to out, escaping exactly as JSON.stringify
/// does for a string with no lone surrogates: " \ and the control
/// characters below 0x20 (short forms where JSON has them, \u00XX else).
/// Every other byte — including multi-byte UTF-8 — is copied verbatim.
///
/// The fast path finds the next byte that needs escaping with memchr3
/// (", \ and LF are the only ones the generator's text can hold in a field
/// value; see unescape_json, which refuses any escape that would put another
/// control character there). A field with none of them is one copy.
fn push_json_string(out: &mut Vec<u8>, s: &[u8]) {
    out.push(b'"');
    let mut rest = s;
    loop {
        match memchr3(b'"', b'\\', b'\n', rest) {
            None => {
                out.extend_from_slice(rest);
                break;
            }
            Some(i) => {
                out.extend_from_slice(&rest[..i]);
                match rest[i] {
                    b'"' => out.extend_from_slice(b"\\\""),
                    b'\\' => out.extend_from_slice(b"\\\\"),
                    _ => out.extend_from_slice(b"\\n"),
                }
                rest = &rest[i + 1..];
            }
        }
    }
    out.push(b'"');
}

fn hex_val(b: u8) -> Option<u32> {
    match b {
        b'0'..=b'9' => Some((b - b'0') as u32),
        b'a'..=b'f' => Some((b - b'a' + 10) as u32),
        b'A'..=b'F' => Some((b - b'A' + 10) as u32),
        _ => None,
    }
}

/// Reads 4 hex digits as a code point.
fn hex4(s: &[u8]) -> Option<u32> {
    let mut v = 0u32;
    for &b in s.iter().take(4) {
        v = (v << 4) | hex_val(b)?;
    }
    Some(v)
}

/// Appends the UTF-8 encoding of cp to out (cp is never a surrogate here).
fn push_utf8(out: &mut Vec<u8>, cp: u32) {
    if cp < 0x80 {
        out.push(cp as u8);
    } else if cp < 0x800 {
        out.push(0xc0 | (cp >> 6) as u8);
        out.push(0x80 | (cp & 0x3f) as u8);
    } else if cp < 0x10000 {
        out.push(0xe0 | (cp >> 12) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3f) as u8);
        out.push(0x80 | (cp & 0x3f) as u8);
    } else {
        out.push(0xf0 | (cp >> 18) as u8);
        out.push(0x80 | ((cp >> 12) & 0x3f) as u8);
        out.push(0x80 | ((cp >> 6) & 0x3f) as u8);
        out.push(0x80 | (cp & 0x3f) as u8);
    }
}

/// Unescapes a JSON string's content (the bytes between its quotes) into out.
/// Handles \" \\ \/ \b \f \n \r \t and \uXXXX, including surrogate pairs.
/// A lone surrogate becomes U+FFFD (the generator never emits one). Returns
/// false on an invalid escape, and the caller falls back to the JS reader.
fn unescape_json(src: &[u8], out: &mut Vec<u8>) -> bool {
    out.clear();
    let n = src.len();
    let mut i = 0usize;
    while i < n {
        match memchr(b'\\', &src[i..]) {
            None => {
                out.extend_from_slice(&src[i..]);
                return true;
            }
            Some(rel) => {
                let j = i + rel;
                out.extend_from_slice(&src[i..j]);
                if j + 1 >= n {
                    return false;
                }
                match src[j + 1] {
                    b'"' => {
                        out.push(b'"');
                        i = j + 2;
                    }
                    b'\\' => {
                        out.push(b'\\');
                        i = j + 2;
                    }
                    b'/' => {
                        out.push(b'/');
                        i = j + 2;
                    }
                    // \b \f \t would put a control character other than LF
                    // or CR into the text, and the field emitter only
                    // escapes ", \ and LF: refuse, and the driver falls back
                    // to the plain JS reader for this case.
                    b'b' | b'f' | b't' => return false,
                    b'n' => {
                        out.push(b'\n');
                        i = j + 2;
                    }
                    b'r' => {
                        out.push(b'\r');
                        i = j + 2;
                    }
                    b'u' => {
                        if j + 6 > n {
                            return false;
                        }
                        let cp = match hex4(&src[j + 2..j + 6]) {
                            Some(v) => v,
                            None => return false,
                        };
                        // A control character other than LF or CR would
                        // reach a field value unescaped: refuse, and the
                        // driver falls back to the plain JS reader.
                        if cp < 0x20 && cp != 0x0a && cp != 0x0d {
                            return false;
                        }
                        if (0xd800..0xdc00).contains(&cp) {
                            // A high surrogate: a low one must follow as \uDC00-\uDFFF.
                            if j + 12 <= n && src[j + 6] == b'\\' && src[j + 7] == b'u' {
                                if let Some(lo) = hex4(&src[j + 8..j + 12]) {
                                    if (0xdc00..0xe000).contains(&lo) {
                                        let c =
                                            0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                                        push_utf8(out, c);
                                        i = j + 12;
                                        continue;
                                    }
                                } else {
                                    return false;
                                }
                            }
                            push_utf8(out, 0xfffd);
                            i = j + 6;
                        } else if (0xdc00..0xe000).contains(&cp) {
                            push_utf8(out, 0xfffd);
                            i = j + 6;
                        } else {
                            push_utf8(out, cp);
                            i = j + 6;
                        }
                    }
                    _ => return false,
                }
            }
        }
    }
    true
}

/// The parser. `text` is the unescaped CSV text; `out` receives the answer
/// JSON, built as the records are read.
struct Parser<'a> {
    text: &'a [u8],
    out: &'a mut Vec<u8>,
    header: bool,
    pos: usize,
    line: usize,
    record_line: usize,
    record_row: Option<usize>,
    ended: u8,
    added_out: usize,
    /// The record being read: its field values, packed end to end.
    arena: Vec<u8>,
    /// (start, len) in arena, one per field of the record being read.
    spans: Vec<(u32, u32)>,
    /// Whether the record's last field was quoted.
    quoted: bool,
    width: i64,
    rows_len: usize,
    first_row: bool,
    errors: Vec<Error>,
    columns_done: bool,
}

impl<'a> Parser<'a> {
    fn new(text: &'a [u8], out: &'a mut Vec<u8>, header: bool) -> Self {
        // A leading BOM is skipped, as run() skips U+FEFF.
        let pos = if text.starts_with(&[0xef, 0xbb, 0xbf]) {
            3
        } else {
            0
        };
        Parser {
            text,
            out,
            header,
            pos,
            line: 1,
            record_line: 1,
            record_row: None,
            ended: END,
            added_out: 0,
            arena: Vec::with_capacity(4096),
            spans: Vec::with_capacity(32),
            quoted: false,
            width: -1,
            rows_len: 0,
            first_row: true,
            errors: Vec::new(),
            columns_done: false,
        }
    }

    fn error(&mut self, code: &'static str) {
        self.errors.push(Error {
            code,
            line: self.record_line,
            row: self.record_row,
            fields: None,
            extra: Vec::new(),
        });
    }

    fn span_len(&self, k: usize) -> usize {
        self.spans[k].1 as usize
    }

    /// The next delimiter (, CR or LF) at or after pos, and which it is.
    fn find_delim(&self, from: usize) -> Option<(usize, u8)> {
        let rel = memchr3(b',', b'\r', b'\n', &self.text[from..])?;
        let i = from + rel;
        Some((i, self.text[i]))
    }

    /// Appends text[a..b) to the arena, reading each CRLF or lone CR in it
    /// as one LF and counting the lines it crosses. A segment with no line
    /// break in it is one copy.
    fn append_segment(&mut self, a: usize, b: usize) {
        if a >= b {
            return;
        }
        if memchr(b'\n', &self.text[a..b]).is_none()
            && memchr(b'\r', &self.text[a..b]).is_none()
        {
            self.arena.extend_from_slice(&self.text[a..b]);
            return;
        }
        let mut start = a;
        let mut i = a;
        while i < b {
            let c = self.text[i];
            if c == b'\r' {
                self.arena.extend_from_slice(&self.text[start..i]);
                self.arena.push(b'\n');
                self.line += 1;
                i += if self.text.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = i;
            } else if c == b'\n' {
                self.arena.extend_from_slice(&self.text[start..i]);
                self.arena.push(b'\n');
                self.line += 1;
                i += 1;
                start = i;
            } else {
                i += 1;
            }
        }
        self.arena.extend_from_slice(&self.text[start..b]);
    }

    /// Reads unquoted characters onto the arena from `arena_start`, up to
    /// the next comma or line break; a CR not followed by LF is dropped
    /// (stray_cr). Sets `ended` and `added_out` and records the field's span.
    fn scan_unquoted(&mut self, arena_start: usize) {
        let n = self.text.len();
        let mut added = 0usize;
        let mut start = self.pos;
        loop {
            let (i, c) = match self.find_delim(self.pos) {
                None => {
                    if n > start {
                        self.arena.extend_from_slice(&self.text[start..n]);
                        added += n - start;
                    }
                    self.pos = n;
                    self.ended = END;
                    self.added_out = added;
                    self.spans.push((
                        arena_start as u32,
                        (self.arena.len() - arena_start) as u32,
                    ));
                    return;
                }
                Some(x) => x,
            };
            match c {
                b',' => {
                    if i > start {
                        self.arena.extend_from_slice(&self.text[start..i]);
                        added += i - start;
                    }
                    self.pos = i + 1;
                    self.ended = COMMA;
                    self.added_out = added;
                    self.spans.push((
                        arena_start as u32,
                        (self.arena.len() - arena_start) as u32,
                    ));
                    return;
                }
                b'\n' => {
                    // A CR just before it makes the break a CRLF.
                    let e = if i > start && self.text[i - 1] == b'\r' {
                        i - 1
                    } else {
                        i
                    };
                    if e > start {
                        self.arena.extend_from_slice(&self.text[start..e]);
                        added += e - start;
                    }
                    self.pos = i + 1;
                    self.line += 1;
                    self.ended = LINE_BREAK;
                    self.added_out = added;
                    self.spans.push((
                        arena_start as u32,
                        (self.arena.len() - arena_start) as u32,
                    ));
                    return;
                }
                _ => {
                    // A CR: a line break when LF follows it, else a stray CR to drop.
                    if self.text.get(i + 1) == Some(&b'\n') {
                        if i > start {
                            self.arena.extend_from_slice(&self.text[start..i]);
                            added += i - start;
                        }
                        self.pos = i + 2;
                        self.line += 1;
                        self.ended = LINE_BREAK;
                        self.added_out = added;
                        self.spans.push((
                            arena_start as u32,
                            (self.arena.len() - arena_start) as u32,
                        ));
                        return;
                    }
                    self.error("stray_cr");
                    if i > start {
                        self.arena.extend_from_slice(&self.text[start..i]);
                        added += i - start;
                    }
                    self.pos = i + 1;
                    start = i + 1;
                }
            }
        }
    }

    /// Reads a quoted field whose opening quote is at pos. Sets `ended` and
    /// records the field's span.
    fn scan_quoted(&mut self) {
        let open = self.pos;
        let open_line = self.line;
        let arena_start = self.arena.len();
        let mut from = self.pos + 1;
        let n = self.text.len();
        loop {
            let q = match memchr(b'"', &self.text[from..]) {
                None => {
                    // The quote never closes: it is a literal character, and
                    // the text after it is read again as unquoted.
                    self.pos = open + 1;
                    self.line = open_line;
                    self.error("unterminated_quote");
                    self.arena.truncate(arena_start);
                    self.arena.push(b'"');
                    self.scan_unquoted(arena_start);
                    return;
                }
                Some(rel) => from + rel,
            };
            if self.text.get(q + 1) == Some(&b'"') {
                // A doubled quote: one quote in the value, and the scan goes on.
                self.append_segment(from, q);
                self.arena.push(b'"');
                from = q + 2;
                continue;
            }
            // The closing quote.
            self.append_segment(from, q);
            self.pos = q + 1;
            if self.pos >= n {
                self.ended = END;
                self.spans.push((
                    arena_start as u32,
                    (self.arena.len() - arena_start) as u32,
                ));
                return;
            }
            let c = self.text[self.pos];
            if c == b',' {
                self.pos += 1;
                self.ended = COMMA;
                self.spans.push((
                    arena_start as u32,
                    (self.arena.len() - arena_start) as u32,
                ));
                return;
            }
            if c == b'\n' {
                self.pos += 1;
                self.line += 1;
                self.ended = LINE_BREAK;
                self.spans.push((
                    arena_start as u32,
                    (self.arena.len() - arena_start) as u32,
                ));
                return;
            }
            if c == b'\r' && self.text.get(self.pos + 1) == Some(&b'\n') {
                self.pos += 2;
                self.line += 1;
                self.ended = LINE_BREAK;
                self.spans.push((
                    arena_start as u32,
                    (self.arena.len() - arena_start) as u32,
                ));
                return;
            }
            // What follows the closing quote is appended as it stands, up to
            // the next comma or line break.
            self.scan_unquoted(arena_start);
            if self.added_out > 0 {
                self.error("quote_junk");
            }
            return;
        }
    }

    /// Reads one record, skipping blank lines first. Returns false when the
    /// text is spent. The record's fields land in spans/arena.
    fn parse_one_record(&mut self) -> bool {
        let n = self.text.len();
        loop {
            if self.pos >= n {
                return false;
            }
            let c = self.text[self.pos];
            if c == b'\n' {
                self.pos += 1;
                self.line += 1;
            } else if c == b'\r' && self.text.get(self.pos + 1) == Some(&b'\n') {
                self.pos += 2;
                self.line += 1;
            } else {
                break;
            }
        }
        self.record_line = self.line;
        self.record_row = if self.header && !self.columns_done {
            None
        } else {
            Some(self.rows_len)
        };
        self.arena.clear();
        self.spans.clear();
        self.quoted = false;
        loop {
            if self.pos >= n {
                // A trailing comma leaves one empty field.
                self.quoted = false;
                self.spans.push((self.arena.len() as u32, 0));
                self.ended = END;
                break;
            }
            if self.text[self.pos] == b'"' {
                self.quoted = true;
                self.scan_quoted();
            } else {
                self.quoted = false;
                self.scan_unquoted(self.arena.len());
            }
            if self.ended != COMMA {
                break;
            }
        }
        true
    }

    /// Whether the record just read held no characters (a single empty
    /// unquoted field) and is dropped.
    fn is_dropped(&self) -> bool {
        self.spans.len() == 1 && self.span_len(0) == 0 && !self.quoted
    }

    /// Emits the record just read as the header's columns array.
    fn emit_columns(&mut self) {
        self.out.extend_from_slice(b"{\"columns\":[");
        for k in 0..self.spans.len() {
            if k > 0 {
                self.out.push(b',');
            }
            let (s, l) = self.spans[k];
            // The arena slice is borrowed directly: no copy per field.
            let v = &self.arena[s as usize..(s as usize + l as usize)];
            push_json_string(&mut *self.out, v);
        }
        self.out.push(b']');
    }

    /// Finishes the record just read: records a short/long error, emits its
    /// row JSON into out, and returns true when a row was emitted.
    fn finish_record(&mut self) -> bool {
        if self.is_dropped() {
            return false;
        }
        if self.width < 0 {
            self.width = self.spans.len() as i64;
        }
        let width = self.width as usize;
        let nfields = self.spans.len();
        if nfields < width {
            self.errors.push(Error {
                code: "short_row",
                line: self.record_line,
                row: self.record_row,
                fields: Some(nfields),
                extra: Vec::new(),
            });
        } else if nfields > width {
            let mut extra = Vec::new();
            for k in width..nfields {
                let (s, l) = self.spans[k];
                extra.push(self.arena[s as usize..(s as usize + l as usize)].to_vec());
            }
            self.errors.push(Error {
                code: "long_row",
                line: self.record_line,
                row: self.record_row,
                fields: None,
                extra,
            });
        }
        if !self.first_row {
            self.out.push(b',');
        }
        self.first_row = false;
        self.out.push(b'[');
        let emit_n = nfields.min(width);
        let mut need_comma = false;
        for k in 0..emit_n {
            if need_comma {
                self.out.push(b',');
            }
            need_comma = true;
            let (s, l) = self.spans[k];
            // The arena slice is borrowed directly: no copy per field.
            let v = &self.arena[s as usize..(s as usize + l as usize)];
            push_json_string(&mut *self.out, v);
        }
        for _ in emit_n..width {
            if need_comma {
                self.out.push(b',');
            }
            need_comma = true;
            self.out.extend_from_slice(b"\"\"");
        }
        self.out.push(b']');
        self.rows_len += 1;
        true
    }

    /// Emits the collected errors as a JSON array (without the brackets).
    fn emit_errors(&mut self) {
        let errors = std::mem::take(&mut self.errors);
        for (i, e) in errors.iter().enumerate() {
            if i > 0 {
                self.out.push(b',');
            }
            self.out.extend_from_slice(b"{\"code\":\"");
            self.out.extend_from_slice(e.code.as_bytes());
            self.out.extend_from_slice(b"\",\"line\":");
            self.out.extend_from_slice(e.line.to_string().as_bytes());
            self.out.extend_from_slice(b",\"row\":");
            match e.row {
                Some(r) => self.out.extend_from_slice(r.to_string().as_bytes()),
                None => self.out.extend_from_slice(b"null"),
            }
            if let Some(f) = e.fields {
                self.out.extend_from_slice(b",\"fields\":");
                self.out.extend_from_slice(f.to_string().as_bytes());
            }
            if !e.extra.is_empty() {
                self.out.extend_from_slice(b",\"extra\":[");
                for (k, v) in e.extra.iter().enumerate() {
                    if k > 0 {
                        self.out.push(b',');
                    }
                    push_json_string(self.out, v);
                }
                self.out.push(b']');
            }
            self.out.push(b'}');
        }
    }

    /// Parses the whole text and writes the answer JSON to out.
    fn run(&mut self) {
        if self.header {
            loop {
                if !self.parse_one_record() {
                    break;
                }
                if self.is_dropped() {
                    continue;
                }
                self.emit_columns();
                self.width = self.spans.len() as i64;
                self.columns_done = true;
                break;
            }
            if !self.columns_done {
                self.out.extend_from_slice(b"{\"columns\":[]");
                self.columns_done = true;
            }
        } else {
            self.out.extend_from_slice(b"{\"columns\":null");
            self.columns_done = true;
        }
        self.out.extend_from_slice(b",\"rows\":[");
        while self.parse_one_record() {
            self.finish_record();
        }
        self.out.extend_from_slice(b"],\"errors\":[");
        self.emit_errors();
        self.out.extend_from_slice(b"]}");
    }
}

// ---------------------------------------------------------------------------
// The WASM boundary: three buffers owned by this module. The driver copies
// a case's escaped "text" token into TOKEN, calls parse_case, and reads the
// answer JSON from OUT.
// ---------------------------------------------------------------------------

static mut TOKEN: Vec<u8> = Vec::new();
static mut TEXT: Vec<u8> = Vec::new();
static mut OUT: Vec<u8> = Vec::new();

/// Reserves the buffers so the driver can write into them.
#[no_mangle]
pub extern "C" fn init() {
    unsafe {
        TOKEN.reserve(8 * 1024 * 1024);
        TEXT.reserve(4 * 1024 * 1024);
        OUT.reserve(4 * 1024 * 1024);
    }
}

/// Where the driver writes the escaped token.
#[no_mangle]
pub extern "C" fn token_ptr() -> *mut u8 {
    unsafe { TOKEN.as_mut_ptr() }
}

/// How many token bytes fit without growing.
#[no_mangle]
pub extern "C" fn token_capacity() -> usize {
    unsafe { TOKEN.capacity() }
}

/// Grows the token buffer to hold at least cap bytes.
#[no_mangle]
pub extern "C" fn reserve_token(cap: usize) {
    unsafe {
        if cap > TOKEN.capacity() {
            TOKEN.reserve(cap - TOKEN.capacity());
        }
    }
}

/// Where the answer JSON sits after parse_case.
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    unsafe { OUT.as_ptr() }
}

/// Parses the escaped token in TOKEN[..token_len] with the header flag and
/// writes the answer JSON to OUT. Returns the answer's length, or 0 when the
/// token holds an escape this reader does not handle.
#[no_mangle]
pub extern "C" fn parse_case(token_len: usize, header: u32) -> usize {
    unsafe {
        // TOKEN is reserved, not filled: its length is 0, so the token is
        // read through its pointer, not by indexing the Vec.
        if token_len > TOKEN.capacity() {
            return 0;
        }
        let token = std::slice::from_raw_parts(TOKEN.as_ptr(), token_len);
        TEXT.clear();
        if !unescape_json(token, &mut TEXT) {
            return 0;
        }
        OUT.clear();
        let mut p = Parser::new(&TEXT, &mut OUT, header != 0);
        p.run();
        OUT.len()
    }
}
