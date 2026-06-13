"use client";

/**
 * MarkdownWithCitations.tsx
 *
 * Renders assistant markdown and replaces inline citation markers like
 * [1], [2] with small clickable badges. The number N maps to a 0-based
 * source index (so [1] → index 0) passed to onCiteClick.
 *
 * Shared by MessageBubble (static messages) and TypewriterText (the
 * latest message, once its animation completes) so badges appear
 * consistently on every bot message.
 */

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";

const CITATION_RE = /\[(\d+)\]/g;

function CitationBadge({ n, onClick }: { n: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Source ${n}`}
      className="inline-flex items-center justify-center mx-0.5 cursor-pointer"
      style={{
        width: 16,
        height: 16,
        background: "#E1F5EE",
        color: "#0F6E56",
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 1,
        verticalAlign: "middle",
      }}
    >
      {n}
    </button>
  );
}

/**
 * Walk the rendered children; in any text node, replace [N] occurrences
 * with CitationBadge components. Recurses into inline elements (strong,
 * em, a, …) so a citation inside formatted text is still caught.
 */
function injectCitations(
  children: React.ReactNode,
  onCiteClick?: (index: number) => void,
  keyPrefix = "cite",
): React.ReactNode {
  return React.Children.map(children, (child, childIdx) => {
    if (typeof child === "string") {
      const re = new RegExp(CITATION_RE.source, "g");
      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(child)) !== null) {
        if (match.index > lastIndex) parts.push(child.slice(lastIndex, match.index));
        const n = parseInt(match[1], 10);
        parts.push(
          <CitationBadge
            key={`${keyPrefix}-${childIdx}-${match.index}`}
            n={n}
            onClick={() => onCiteClick?.(n - 1)}
          />,
        );
        lastIndex = match.index + match[0].length;
      }
      if (parts.length === 0) return child;
      if (lastIndex < child.length) parts.push(child.slice(lastIndex));
      return parts;
    }

    if (React.isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: React.ReactNode }>;
      if (el.props?.children != null) {
        return React.cloneElement(
          el,
          undefined,
          injectCitations(el.props.children, onCiteClick, `${keyPrefix}-${childIdx}`),
        );
      }
    }
    return child;
  });
}

interface Props {
  content: string;
  onCiteClick?: (index: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function MarkdownWithCitations({ content, onCiteClick, className, style }: Props) {
  // Override the block-level elements that hold text; inline emphasis is
  // reached via injectCitations' recursion, so we don't double-process.
  const wrap =
    (Tag: React.ElementType) =>
    ({ children }: { children?: React.ReactNode }) =>
      <Tag>{injectCitations(children, onCiteClick)}</Tag>;

  const components: Components = {
    p: wrap("p"),
    li: wrap("li"),
    h1: wrap("h1"),
    h2: wrap("h2"),
    h3: wrap("h3"),
    h4: wrap("h4"),
    h5: wrap("h5"),
    h6: wrap("h6"),
    td: wrap("td"),
    th: wrap("th"),
    blockquote: wrap("blockquote"),
  };

  return (
    <div className={className} style={style}>
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}
