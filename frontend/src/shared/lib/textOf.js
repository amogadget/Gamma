// Plain text of a rendered element tree (link labels arrive as React
// children). Shared by the note renderer and the chat's link card.
export function textOf(children) {
  if (children == null) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children.props?.children != null) return textOf(children.props.children);
  return "";
}
