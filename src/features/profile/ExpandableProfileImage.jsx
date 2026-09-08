import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, X } from "lucide-react";
import { profileNftImageCandidates } from "./profile-nft-images.js";
import "./profile-image-viewer.css";

function ProfileImageDialog({ nft, onClose, triggerRef }) {
  const dialog = useRef(null);
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const candidates = profileNftImageCandidates(nft, { thumbnailFallback: false });
  const src = candidates[index];
  const title = nft?.title || "Profile picture";
  useEffect(() => {
    const element = dialog.current;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      trigger?.focus({ preventScroll: true });
    };
  }, [triggerRef]);
  return createPortal(
    <dialog ref={dialog} className="profile-image-dialog" aria-labelledby={titleId}
      onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="Close picture" onClick={onClose} autoFocus><X size={22} /></button>
      </header>
      <div className="profile-image-stage">
        {src ? <>
          {!loaded && <span role="status">Loading picture…</span>}
          <img key={src} src={src} alt={title} decoding="async" onLoad={() => setLoaded(true)}
            onError={() => { setLoaded(false); setIndex(value => value + 1); }} style={{ opacity: loaded ? 1 : 0 }} />
        </> : <span role="status">This picture couldn’t be loaded.</span>}
      </div>
    </dialog>, document.body
  );
}

export function ExpandableProfileImage({ nft, children, style, className = "", label, disabled = false }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const available = !disabled && profileNftImageCandidates(nft, { thumbnailFallback: false }).length > 0;
  if (!available) return <div className={className} style={style}>{children}</div>;
  return <>
    <button ref={triggerRef} type="button" className={`profile-image-expand ${className}`} style={style}
      aria-label={label || `Expand ${nft?.title || "profile picture"}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {children}
      <span className="profile-image-expand-icon" aria-hidden="true"><Expand size={16} /></span>
    </button>
    {open && <ProfileImageDialog key={nft?.id || nft?.imageCid || nft?.imageGatewayUrl} nft={nft} onClose={() => setOpen(false)} triggerRef={triggerRef} />}
  </>;
}
