import React from "react";

const NODE_WIDTH = 154;
const NODE_HEIGHT = 58;
const GRAPH_MARGIN = 28;
const GRAPH_GAP_X = 76;
const GRAPH_GAP_Y = 24;

export function DocsDiagram({ source }) {
  const text = String(source || "").trim();
  if (/^sequenceDiagram\b/.test(text)) return <SequenceDiagram source={text} />;
  if (/^stateDiagram-v2\b/.test(text)) return <GraphDiagram source={text} stateMode />;
  if (/^flowchart\b/.test(text)) return <GraphDiagram source={text} />;

  return (
    <pre className="docs-diagram-fallback">
      <code>{text}</code>
    </pre>
  );
}

function GraphDiagram({ source, stateMode = false }) {
  const parsed = parseGraph(source, stateMode);
  if (parsed.nodes.length === 0 || parsed.edges.length === 0) {
    return <DiagramError message="Diagram has no renderable graph edges." source={source} />;
  }

  const levels = graphLevels(parsed.nodes, parsed.edges);
  const columns = groupByLevel(parsed.nodes, levels);
  const maxRows = Math.max(...columns.map((column) => column.length), 1);
  const isVertical = parsed.direction === "TB";
  const width = isVertical
    ? GRAPH_MARGIN * 2 + maxRows * NODE_WIDTH + (maxRows - 1) * GRAPH_GAP_X
    : GRAPH_MARGIN * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * GRAPH_GAP_X;
  const height = isVertical
    ? GRAPH_MARGIN * 2 + columns.length * NODE_HEIGHT + (columns.length - 1) * GRAPH_GAP_Y
    : GRAPH_MARGIN * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * GRAPH_GAP_Y;
  const positions = new Map();

  columns.forEach((column, columnIndex) => {
    column.forEach((node, rowIndex) => {
      const groupSpan = isVertical
        ? column.length * NODE_WIDTH + (column.length - 1) * GRAPH_GAP_X
        : column.length * NODE_HEIGHT + (column.length - 1) * GRAPH_GAP_Y;
      const crossStart = isVertical ? (width - groupSpan) / 2 : (height - groupSpan) / 2;
      positions.set(node.id, {
        x: isVertical
          ? crossStart + rowIndex * (NODE_WIDTH + GRAPH_GAP_X)
          : GRAPH_MARGIN + columnIndex * (NODE_WIDTH + GRAPH_GAP_X),
        y: isVertical
          ? GRAPH_MARGIN + columnIndex * (NODE_HEIGHT + GRAPH_GAP_Y)
          : crossStart + rowIndex * (NODE_HEIGHT + GRAPH_GAP_Y),
      });
    });
  });

  const markerId = `docs-arrow-${hashText(source)}`;

  return (
    <figure className="docs-rendered-diagram">
      <svg aria-label="Architecture diagram" role="img" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id={markerId} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0,0 L8,4 L0,8 Z" fill="#7a776f" />
          </marker>
        </defs>
        {parsed.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          return (
            <path
              className="docs-diagram-edge"
              d={edgePath(from, to, isVertical)}
              key={`${edge.from}-${edge.to}-${index}`}
              markerEnd={`url(#${markerId})`}
            />
          );
        })}
        {parsed.nodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const lines = wrapLabel(node.label, 18).slice(0, 3);
          return (
            <g className={node.kind === "start" ? "docs-diagram-node start" : "docs-diagram-node"} key={node.id}>
              <rect height={NODE_HEIGHT} rx="10" width={NODE_WIDTH} x={position.x} y={position.y} />
              <text textAnchor="middle" x={position.x + NODE_WIDTH / 2} y={position.y + NODE_HEIGHT / 2 - (lines.length - 1) * 8}>
                {lines.map((line, index) => (
                  <tspan dy={index === 0 ? 0 : 16} key={index} x={position.x + NODE_WIDTH / 2}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function SequenceDiagram({ source }) {
  const parsed = parseSequence(source);
  if (parsed.participants.length < 2 || parsed.messages.length === 0) {
    return <DiagramError message="Diagram has no renderable sequence messages." source={source} />;
  }

  const participantWidth = 150;
  const participantGap = 54;
  const margin = 34;
  const rowHeight = 58;
  const headerY = 24;
  const lineTop = 82;
  const width = margin * 2 + parsed.participants.length * participantWidth + (parsed.participants.length - 1) * participantGap;
  const height = lineTop + parsed.messages.length * rowHeight + 36;
  const xById = new Map();
  const markerId = `docs-sequence-arrow-${hashText(source)}`;

  parsed.participants.forEach((participant, index) => {
    xById.set(participant.id, margin + participantWidth / 2 + index * (participantWidth + participantGap));
  });

  return (
    <figure className="docs-rendered-diagram sequence">
      <svg aria-label="Sequence diagram" role="img" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id={markerId} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0,0 L8,4 L0,8 Z" fill="#7a776f" />
          </marker>
        </defs>
        {parsed.participants.map((participant) => {
          const x = xById.get(participant.id);
          return (
            <g className="docs-sequence-participant" key={participant.id}>
              <rect height="36" rx="9" width={participantWidth} x={x - participantWidth / 2} y={headerY} />
              <text textAnchor="middle" x={x} y={headerY + 23}>
                {participant.label}
              </text>
              <line x1={x} x2={x} y1={lineTop - 12} y2={height - 18} />
            </g>
          );
        })}
        {parsed.messages.map((message, index) => {
          const fromX = xById.get(message.from);
          const toX = xById.get(message.to);
          const y = lineTop + index * rowHeight;
          if (!fromX || !toX) return null;
          const labelLines = wrapLabel(message.label, 38).slice(0, 2);
          return (
            <g className="docs-sequence-message" key={`${message.from}-${message.to}-${index}`}>
              <line
                markerEnd={`url(#${markerId})`}
                strokeDasharray={message.dashed ? "5 5" : ""}
                x1={fromX}
                x2={toX}
                y1={y}
                y2={y}
              />
              <text textAnchor="middle" x={(fromX + toX) / 2} y={y - 9}>
                {labelLines.map((line, lineIndex) => (
                  <tspan dy={lineIndex === 0 ? 0 : 14} key={lineIndex} x={(fromX + toX) / 2}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function DiagramError({ message, source }) {
  return (
    <figure className="docs-diagram-error">
      <strong>{message}</strong>
      <pre>
        <code>{source}</code>
      </pre>
    </figure>
  );
}

function parseGraph(source, stateMode) {
  const lines = cleanLines(source);
  const header = lines[0] || "";
  const direction = header.includes("TB") ? "TB" : "LR";
  const nodes = new Map();
  const edges = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s*--+>+\s*/);
    if (parts.length !== 2) continue;
    const from = parseNode(parts[0], stateMode);
    const to = parseNode(parts[1], stateMode);
    nodes.set(from.id, from);
    nodes.set(to.id, to);
    edges.push({ from: from.id, to: to.id });
  }

  return { direction, edges, nodes: Array.from(nodes.values()) };
}

function parseSequence(source) {
  const lines = cleanLines(source);
  const participants = new Map();
  const messages = [];

  for (const line of lines.slice(1)) {
    const participant = line.match(/^participant\s+([A-Za-z0-9_]+)\s+as\s+(.+)$/);
    if (participant) {
      participants.set(participant[1], { id: participant[1], label: participant[2].trim() });
      continue;
    }

    const message = line.match(/^([A-Za-z0-9_]+)\s*(-+>>?)\s*([A-Za-z0-9_]+):\s*(.+)$/);
    if (!message) continue;
    for (const id of [message[1], message[3]]) {
      if (!participants.has(id)) participants.set(id, { id, label: id });
    }
    messages.push({
      from: message[1],
      to: message[3],
      dashed: message[2].startsWith("--"),
      label: message[4].trim(),
    });
  }

  return { messages, participants: Array.from(participants.values()) };
}

function parseNode(token, stateMode) {
  const raw = String(token || "").trim().replace(/;$/, "");
  if (raw === "[*]") return { id: "start", kind: "start", label: "Start" };
  const bracket = raw.match(/^([A-Za-z0-9_]+)\[(.+)\]$/);
  if (bracket) return { id: bracket[1], label: bracket[2].trim() };
  const id = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return { id, label: stateMode ? raw.replace(/_/g, " ") : raw };
}

function graphLevels(nodes, edges) {
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length + edges.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const nextLevel = (levels.get(edge.from) || 0) + 1;
      if ((levels.get(edge.to) || 0) < nextLevel) {
        levels.set(edge.to, nextLevel);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return levels;
}

function groupByLevel(nodes, levels) {
  const maxLevel = Math.max(...Array.from(levels.values()), 0);
  return Array.from({ length: maxLevel + 1 }, (_, level) =>
    nodes.filter((node) => (levels.get(node.id) || 0) === level)
  ).filter((column) => column.length > 0);
}

function edgePath(from, to, isVertical) {
  if (isVertical) {
    const startX = from.x + NODE_WIDTH / 2;
    const startY = from.y + NODE_HEIGHT;
    const endX = to.x + NODE_WIDTH / 2;
    const endY = to.y;
    const midY = (startY + endY) / 2;
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const midX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
}

function cleanLines(source) {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("%%"));
}

function wrapLabel(label, maxChars) {
  const words = String(label || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [String(label || "")];
}

function hashText(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

