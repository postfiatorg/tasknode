import { markdownToBlocks } from "../chat/chat-markdown.js";
import { formatTaskDescription, formatTaskParagraphs, linkifyInline } from "./task-description-format.js";

function linkifyParts(parts = [], repo = "") {
  return parts.flatMap((part) => (typeof part.text === "string" && part.text ? linkifyInline(part.text, { repo }) : [part]));
}

export function TaskInline({ parts = [] }) {
  return parts.map((part, index) => {
    if (part.href) {
      return (
        <a href={part.href} key={index} rel="noopener noreferrer" target="_blank">
          {part.link}
        </a>
      );
    }
    if (part.code) return <code key={index}>{part.code}</code>;
    if (part.bold) return <strong key={index}>{part.bold}</strong>;
    if (part.italic) return <em key={index}>{part.italic}</em>;
    return <span key={index}>{part.text}</span>;
  });
}

function MarkdownBlocks({ markdown, repo }) {
  return markdownToBlocks(markdown).map((block, index) => {
    const inline = linkifyParts(block.inline || [{ text: block.text || "" }], repo);
    if (block.type === "h2" || block.type === "h3") return <h4 className="task-rich-heading" key={index}><TaskInline parts={inline} /></h4>;
    if (block.type === "quote") return <blockquote key={index}><TaskInline parts={inline} /></blockquote>;
    if (block.type === "ul" || block.type === "ol") {
      const List = block.type;
      return (
        <List key={index} start={block.type === "ol" && Number(block.start) > 1 ? Number(block.start) : undefined}>
          {(block.items || []).map((item, itemIndex) => (
            <li key={itemIndex}><TaskInline parts={linkifyParts(Array.isArray(item) ? item : [{ text: item }], repo)} /></li>
          ))}
        </List>
      );
    }
    if (block.type === "table") {
      const cells = (row) => row.flatMap((cell, cellIndex) => [
        ...(cellIndex ? [{ text: " · " }] : []),
        ...linkifyParts(Array.isArray(cell) ? cell : [{ text: cell }], repo),
      ]);
      return [block.headers || [], ...(block.rows || [])].filter((row) => row.length).map((row, rowIndex) => (
        <p key={`${index}-${rowIndex}`}>
          {rowIndex === 0 && block.headers?.length ? <strong><TaskInline parts={cells(row)} /></strong> : <TaskInline parts={cells(row)} />}
        </p>
      ));
    }
    if (block.type === "hr") return null;
    return <p key={index}><TaskInline parts={inline} /></p>;
  });
}

export function TaskDescription({ repo = "", text = "" }) {
  const formatted = formatTaskDescription(text, { repo });
  if (formatted.markdown) {
    return <div className="task-rich-text"><MarkdownBlocks markdown={formatted.markdown} repo={formatted.repo} /></div>;
  }
  return (
    <div className="task-rich-text">
      {formatted.lead && <p className="task-rich-lead"><TaskInline parts={formatted.lead} /></p>}
      {formatted.paragraphs.map((paragraph, index) => (
        <p key={index}><TaskInline parts={paragraph} /></p>
      ))}
      {formatted.terms.length > 0 && (
        <div className="task-rich-terms">
          <span>Payment terms</span>
          {formatted.terms.map((term, index) => (
            <p key={index}><TaskInline parts={term} /></p>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskParagraphs({ repo = "", text = "" }) {
  return (
    <div className="task-rich-text">
      {formatTaskParagraphs(text, { repo }).map((paragraph, index) => (
        <p key={index}><TaskInline parts={paragraph} /></p>
      ))}
    </div>
  );
}

export function TaskStepText({ repo = "", text = "" }) {
  return <TaskInline parts={linkifyInline(text, { repo })} />;
}
