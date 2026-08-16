import { Suspense } from "react";

export function ExtensionSurface({ context, extension }) {
  if (!extension || !extension.enabled(context)) return null;
  const Component = extension.component;
  return (
    <Suspense fallback={<div className="status-banner">{extension.loadingLabel}</div>}>
      <Component {...extension.props(context)} />
    </Suspense>
  );
}
