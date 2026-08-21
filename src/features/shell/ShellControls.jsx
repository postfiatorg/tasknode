
export function SidebarButton({ active, badge, icon: Icon, label, onClick, sidebarOpen, tooltip, trailing }) {
  return (
    <button
      aria-label={label}
      className={active ? "active" : ""}
      data-tooltip={sidebarOpen ? undefined : tooltip || label}
      onClick={onClick}
      type="button"
    >
      <Icon size={18} strokeWidth={1.75} />
      {sidebarOpen && <span>{label}</span>}
      {sidebarOpen && trailing}
      {sidebarOpen && badge ? <small>{badge}</small> : null}
      {!sidebarOpen && badge ? <small className="rail-badge">{badge}</small> : null}
    </button>
  );
}

export function PostFiatLogo() {
  return (
    <svg
      aria-hidden="true"
      className="post-fiat-logo"
      fill="none"
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M40 40 160 160m0-120L40 160"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="20"
      />
      <line
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="20"
        x1="40"
        x2="160"
        y1="160"
        y2="160"
      />
    </svg>
  );
}

export function ToolMenuRow({ icon: Icon, label, onClick, trailing }) {
  return (
    <button className="tool-menu-row" onClick={onClick} type="button">
      <Icon size={16} strokeWidth={1.75} />
      <span>{label}</span>
      {trailing}
    </button>
  );
}
