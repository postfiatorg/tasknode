const extensionIdPattern = /^[a-z][a-z0-9-]{1,47}$/;

export function defineTaskNodeExtension(definition = {}) {
  const id = String(definition.id || "").trim();
  const label = String(definition.label || "").trim();
  if (!extensionIdPattern.test(id)) throw new Error(`tasknode_extension_id_invalid:${id}`);
  if (!label || label.length > 48) throw new Error(`tasknode_extension_label_invalid:${id}`);
  if (typeof definition.component !== "object" && typeof definition.component !== "function") {
    throw new Error(`tasknode_extension_component_invalid:${id}`);
  }
  return Object.freeze({
    id,
    label,
    icon: definition.icon,
    component: definition.component,
    menu: definition.menu || "more",
    group: definition.group || "tools",
    order: Number.isFinite(definition.order) ? definition.order : 100,
    requiresAuth: definition.requiresAuth !== false,
    enabled: typeof definition.enabled === "function" ? definition.enabled : () => true,
    props: typeof definition.props === "function" ? definition.props : () => ({}),
    loadingLabel: String(definition.loadingLabel || `Loading ${label.toLowerCase()}`),
  });
}

export function createTaskNodeExtensionRegistry(definitions = []) {
  const byId = new Map();
  for (const definition of definitions) {
    const normalized = defineTaskNodeExtension(definition);
    if (byId.has(normalized.id)) throw new Error(`tasknode_extension_duplicate:${normalized.id}`);
    byId.set(normalized.id, normalized);
  }
  const ordered = [...byId.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return Object.freeze({
    forView(view) { return byId.get(String(view || "")) || null; },
    menu(menu, group, context) {
      return ordered.filter((extension) => extension.menu === menu
        && extension.group === group
        && extension.enabled(context));
    },
    inventory() {
      return ordered.map(({ id, label, menu, group, order, requiresAuth }) => ({ id, label, menu, group, order, requiresAuth }));
    },
  });
}
