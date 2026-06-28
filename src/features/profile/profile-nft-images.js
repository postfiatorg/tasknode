const THUMBNAIL_SIZES = [48, 96, 192];

function uniqueTruthy(values = []) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

export function profileNftAvatarSize(cssSize = 48) {
  return boundedThumbnailSize(Number(cssSize || 48) * 2, 96);
}

function boundedThumbnailSize(value, fallback = 96) {
  const requested = Math.max(1, Math.ceil(Number(value || fallback)));
  return THUMBNAIL_SIZES.find((size) => requested <= size) || THUMBNAIL_SIZES[THUMBNAIL_SIZES.length - 1];
}

export function profileNftImagePath(imageCid = "") {
  const cid = String(imageCid || "").trim();
  return cid ? `/api/profile/nft/image/${encodeURIComponent(cid)}` : "";
}

export function profileNftPfpPath(imageCid = "", { cssSize = 48, size = null } = {}) {
  const cid = String(imageCid || "").trim();
  if (!cid) return "";
  const thumbnailSize = size ? boundedThumbnailSize(size, 96) : profileNftAvatarSize(cssSize);
  return `/api/profile/nft/pfp/${encodeURIComponent(cid)}?size=${thumbnailSize}`;
}

export function profileNftImageCandidates(nft = {}, { avatarCssSize = 0 } = {}) {
  const record = nft || {};
  const candidates = [record.imageDataUrl];
  if (record.imageCid) {
    candidates.push(
      avatarCssSize > 0
        ? profileNftPfpPath(record.imageCid, { cssSize: avatarCssSize })
        : profileNftImagePath(record.imageCid)
    );
    if (avatarCssSize > 0) {
      candidates.push(profileNftImagePath(record.imageCid));
    }
  }
  candidates.push(record.imageGatewayUrl);
  return uniqueTruthy(candidates);
}
