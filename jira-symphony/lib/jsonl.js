// Splits a byte stream into complete JSON objects.
//
// This is not incidental plumbing: individual stream-json events from Claude Code reach
// several KB (a Write tool_use carries the whole file body), so a single JSON object is
// routinely split across stdout chunks. Parsing chunk-by-chunk silently loses events.

/**
 * @param {(obj:any, line:string) => void} onObject
 * @param {(line:string, err:Error) => void} [onBadLine]
 */
export function createJsonlSplitter(onObject, onBadLine) {
  let buf = "";
  return {
    /** Feed a chunk (Buffer or string). */
    push(chunk) {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        emit(line);
      }
    },
    /** Flush a trailing line with no terminating newline. */
    end() {
      const line = buf.trim();
      buf = "";
      if (line) emit(line);
    },
    get pending() { return buf.length; },
  };

  function emit(line) {
    try {
      onObject(JSON.parse(line), line);
    } catch (err) {
      onBadLine?.(line, err);
    }
  }
}
