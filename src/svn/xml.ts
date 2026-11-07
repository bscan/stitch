// A small XML parser for mod_dav_svn responses (OPTIONS, log-report, errors).
// Those are generated, well-formed documents, so this handles elements,
// attributes, text, entities, CDATA, comments and declarations, and nothing
// fancier. Element and attribute names are reduced to their local part
// ("S:log-item" → "log-item"); the namespaces in these responses don't collide.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      top.text += xml.slice(lt + 9, end < 0 ? xml.length : end);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      i = end < 0 ? xml.length : end + 1;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      const name = local(xml.slice(lt + 2, end).trim());
      if (stack.length > 1 && stack[stack.length - 1].name === name) stack.pop();
      else throw new Error(`xml: unexpected </${name}>`);
      i = end + 1;
    } else {
      // Start tag: find its end, skipping quoted attribute values.
      let j = lt + 1;
      let quote = "";
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= xml.length) throw new Error("xml: unterminated tag");
      let body = xml.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const nameEnd = body.search(/[\s]/);
      const name = local(nameEnd < 0 ? body : body.slice(0, nameEnd));
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      for (const m of (nameEnd < 0 ? "" : body.slice(nameEnd)).matchAll(attrRe)) {
        if (m[1].startsWith("xmlns")) continue;
        attrs[local(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
      }
      const el: XmlElement = { name, attrs, children: [], text: "" };
      top.children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`xml: unclosed <${stack[stack.length - 1].name}>`);
  return root;
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Text of an element; base64 when it carries encoding="base64" (svn does that for unusual revprops). */
export function textOf(el: XmlElement | undefined): string | undefined {
  if (!el) return undefined;
  if (el.attrs.encoding === "base64") return Buffer.from(el.text.replace(/\s+/g, ""), "base64").toString("utf8");
  return el.text;
}
