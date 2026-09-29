// The napplet's role, for manifests and intents (NAP-INTENT, napplet/naps ARCHETYPES.md). No registered archetype
// covers a CAD assembly viewer, so this is a draft slug in the style of stlstr's "stl-preview".
export const ARCHETYPE = 'cad-viewer';
export const CONVENTION = `napplet:${ARCHETYPE}/open`;
/** Topics the viewer listens on: the convention itself, and the `<archetype>:<action>` channel stlstr uses. */
export const OPEN_TOPICS = [CONVENTION, `${ARCHETYPE}:open`];
export const READY_TOPIC = `${ARCHETYPE}:ready`;
