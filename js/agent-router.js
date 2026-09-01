/*
 * Pure, deterministic routing contract for Orbit's local intent layer.
 * It is intentionally dependency-free so the same behavior can be evaluated in Node
 * and surfaced in the browser activity timeline.
 */
export function routePrompt(prompt, context = {}) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  const selected = context.selectedObject || null;
  const selectedId = selected?.id || null;
  const color = detectColor(lower);

  const route = (tool, parameters = {}, options = {}) => ({
    tool,
    parameters,
    requiresHumanApproval: Boolean(options.requiresHumanApproval),
    sensitive: Boolean(options.sensitive),
    reason: options.reason || ''
  });

  if (/^(stop|pause|wait)\b/.test(lower)) return route('interrupt_agent_run', {}, { reason: 'The human is interrupting the active run.' });
  if (/\bundo\b|go back|revert/.test(lower)) return route('undo_agent_changes', {}, { reason: 'The human requested a reversible history action.' });
  if (/what do you remember|show (?:my )?(?:preferences|memory)|my (?:preferences|memory)/.test(lower)) return route('get_preferences', {}, { reason: 'The human is asking about persistent project memory.' });
  if (/act as|be (?:my )?(?:designer|engineer|reviewer)|switch (?:to )?(?:designer|engineer|reviewer)/.test(lower)) return route('set_project_persona', { persona: extractPersona(lower) }, { reason: 'The human explicitly selected a project collaboration role.' });
  if (/\bforget\b|remove (?:my )?preference/.test(lower)) return route('remove_preference', { preference: extractPreference(text) }, { reason: 'The human is removing a persistent preference.' });
  if (/\bremember\b|i (?:like|prefer)|always use|my style is/.test(lower)) return route('save_preference', { preference: extractPreference(text) }, { reason: 'The human is teaching Orbit a persistent project preference.' });
  if (/activity timeline|agent timeline|what did (?:the )?agent do|show (?:the )?timeline|time travel/.test(lower)) return route('get_activity_timeline', {}, { reason: 'The human is asking to inspect decisions over time.' });
  if (/what(?: is|’s|')?(?: currently)? (?:in|on) (?:my |the )?scene|list (?:the )?objects|show (?:me )?(?:the )?scene/.test(lower)) return route('get_scene', {}, { reason: 'The request asks for complete scene state.' });
  if (/what is this|why did you (?:put|add|make)|selected object|what(?:’s| is) selected/.test(lower)) return route('get_selected_object', {}, { reason: 'The request is anchored to the human selection.' });
  if (/find |where (?:is|are) |front windows|left front wheel|glass objects/.test(lower)) return route('find_objects', { query: semanticQuery(text) }, { reason: 'The request names scene objects semantically.' });
  if (/(?:add|set|create)\s+(?:a\s+)?(?:\w+\s+){0,2}constraint|keep .*?(?:same size|symmetric)|must be .*?(?:tall|wide)|(?:symmetry|ground) constraint/.test(lower)) {
    const type = /ground|floor/.test(lower) ? 'ground' : 'symmetry';
    return route('add_constraint', { type }, { requiresHumanApproval: true, reason: 'A guardrail changes future agent behavior and is visible to the human.' });
  }
  if (/inspect|describe (?:this|that|the selected)|tell me about (?:this|that)|what (?:is|are) the (?:dimensions|bounds|materials?)/.test(lower)) return route('inspect_object', { object_id: selectedId || '$selected' }, { reason: 'The human is asking for a deep read of one object before changing it.' });
  if (/what (?:textures?|finishes|materials?) (?:are|can)|list (?:textures?|finishes|surface options)/.test(lower)) return route('list_surface_options', {}, { reason: 'The request asks which surface options actually exist.' });
  if (selectedId && /texture|rough|matte|polish|gloss|shiny|brushed|grain|checker|hatch|dotted|perforat/.test(lower)) {
    return route('refine_texture', { object_id: selectedId, ...textureParameters(lower) }, { requiresHumanApproval: true, reason: 'A surface refinement is staged so the human sees it apply in the viewport.' });
  }
  if (selectedId && /low[ -]?poly|high[ -]?(?:poly|res)|faceted|resolution|taller|wider|flatten|squash|stretch|rotate|turn it|convert (?:it|this) (?:in)?to/.test(lower)) {
    return route('edit_geometry', { object_id: selectedId, ...geometryParameters(lower) }, { requiresHumanApproval: true, reason: 'A geometry change is staged so the human watches it apply in the viewport.' });
  }
  if (/validate|intersections?|constraints?|production ready/.test(lower)) return route('validate_scene', {}, { reason: 'The request asks for deterministic validation.' });
  if (/review|diagnos|check (?:the )?(?:scene|model)|is my model good|quality score/.test(lower)) return route('analyze_design', {}, { reason: 'The request asks for a non-mutating scene review.' });
  if (/save (?:a )?(?:checkpoint|version)|create (?:a )?version/.test(lower)) return route('create_version', { name: extractVersionName(text) }, { reason: 'The request saves a recoverable checkpoint.' });
  if (/restore|go back to version|return to version/.test(lower)) return route('restore_version', { version_id: context.versionId || '$requested_version', version_label: extractRestoreTarget(text) }, { requiresHumanApproval: true, sensitive: true, reason: 'Restoring a version overwrites the visible scene.' });
  if (/export|stl|3d print/.test(lower)) return route('export_stl', {}, { requiresHumanApproval: true, sensitive: true, reason: 'File export is a sensitive action.' });
  if (/share|send (?:this )?(?:model|scene)|link/.test(lower)) return route('share_scene', {}, { requiresHumanApproval: true, sensitive: true, reason: 'Sharing creates a transferable scene link.' });
  if (/comment|annotat|leave (?:a )?note/.test(lower)) return route('add_comment', { object_id: selectedId || '$selected', text: extractCommentText(text) }, { reason: 'The request adds context directly to a scene object.' });
  if (/clear|delete everything|empty scene/.test(lower)) return route('propose_changes', { title: 'Clear the shared scene', changes: [{ operation: 'delete', object_id: '$all' }] }, { requiresHumanApproval: true, sensitive: true, reason: 'Bulk deletion is staged rather than executed directly.' });
  if (/rocket/.test(lower)) return route('create_composite_object', { name: 'rocket', style: styleFrom(lower), components: '$rocket_components' }, { requiresHumanApproval: true, reason: 'A multipart object should be reviewed component by component.' });
  if (/delivery drone|drone|quadcopter/.test(lower)) return route('create_composite_object', { name: 'delivery drone', style: styleFrom(lower), components: '$drone_components' }, { requiresHumanApproval: true, reason: 'A multipart object should be reviewed component by component.' });
  if (/robot/.test(lower)) return route('create_composite_object', { name: 'robot', style: styleFrom(lower), components: '$robot_components' }, { requiresHumanApproval: true, reason: 'A multipart object should be reviewed component by component.' });
  if (/symmetr|mirror|balanced/.test(lower)) return route('propose_changes', { title: 'Balance the shared model', changes: [{ operation: 'symmetrize' }] }, { requiresHumanApproval: true, reason: 'Mirroring changes visible geometry and is staged.' });

  const primitive = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane'].find((type) => new RegExp(`\\b${type}\\b`).test(lower));
  if (/\badd|create|place|put\b/.test(lower) && primitive) {
    return route('propose_changes', { title: `Add ${primitive}`, changes: [{ operation: 'create', object: { type: primitive, color: color || undefined } }] }, { requiresHumanApproval: true, reason: 'New geometry is proposed as a reversible change.' });
  }

  if (selectedId && (color || /transparent|glass|glow|emissive|metal|metallic|bigger|larger|smaller|compact|left|right|up|down|duplicate|copy/.test(lower))) {
    const patch = {};
    if (color) patch.color = color;
    if (/transparent|glass/.test(lower)) patch.material = 'glass';
    if (/glow|emissive|light/.test(lower)) patch.material = 'emissive';
    if (/metal|metallic|chrome/.test(lower)) patch.material = 'metal';
    if (/bigger|larger/.test(lower)) patch.scale = '$scale_up_125';
    if (/smaller|compact|shrink/.test(lower)) patch.scale = '$scale_down_78';
    if (/left|right|up|down/.test(lower)) patch.position = '$relative_position';
    if (/duplicate|copy/.test(lower)) return route('propose_changes', { title: `Duplicate ${selected.name || 'selected object'}`, changes: [{ operation: 'create', object: '$selected_duplicate' }] }, { requiresHumanApproval: true, reason: 'A nearby variation is created as a visible proposal.' });
    return route('modify_object', { object_id: selectedId, patch }, { requiresHumanApproval: true, reason: 'The selected object is passed as live context, not guessed.' });
  }

  return route('propose_changes', { title: 'Starter concept study', changes: [{ operation: 'create', object: { type: 'cube' } }] }, { requiresHumanApproval: true, reason: 'A minimal reversible concept is safer than guessing a complex model.' });
}

/* The studio palette is monochrome, so colour words resolve to greyscale values. */
export function detectColor(text) {
  const map = {
    black: '#111111', ink: '#111111', charcoal: '#2b2b2b', graphite: '#3d3d3d',
    dark: '#3d3d3d', grey: '#8a8a8a', gray: '#8a8a8a', steel: '#a5a5a5',
    silver: '#c8c8c8', light: '#d6d6d6', ash: '#d6d6d6', chalk: '#efefef',
    white: '#fafafa', bone: '#efefef'
  };
  const key = Object.keys(map).find((word) => new RegExp(`\\b${word}\\b`).test(text));
  return key ? map[key] : null;
}

/* Deterministic parameter extraction for the Codex-style refine loop. */
export function textureParameters(lower) {
  const parameters = {};
  if (/\bbrushed\b|streak/.test(lower)) parameters.texture = 'brushed';
  else if (/\bgrid\b|panel/.test(lower)) parameters.texture = 'grid';
  else if (/\bgrain(?:y)?\b|\bnoise\b|speckle/.test(lower)) parameters.texture = 'noise';
  else if (/\bchecker(?:ed|board)?\b/.test(lower)) parameters.texture = 'checker';
  else if (/\bhatch(?:ed|ing)?\b/.test(lower)) parameters.texture = 'hatch';
  else if (/\bdot(?:s|ted)\b|perforat/.test(lower)) parameters.texture = 'dots';
  else if (/(?:remove|clear|no) (?:the )?texture/.test(lower)) parameters.texture = 'none';
  if (/\brough(?:er|en)?\b|\bmatte?\b|\bcoarse(?:r)?\b/.test(lower)) parameters.roughness = 0.85;
  if (/\bpolish(?:ed)?\b|\bgloss(?:y)?\b|\bshin(?:y|ier)\b|\bsmooth(?:er)?\b/.test(lower)) parameters.roughness = 0.12;
  if (/metal|metallic|chrome/.test(lower)) parameters.finish = 'metal';
  return parameters;
}

export function geometryParameters(lower) {
  if (/low[ -]?poly|faceted/.test(lower)) return { operation: 'set_detail', detail: 'low' };
  if (/high[ -]?(?:poly|res)|denser mesh|smoother mesh/.test(lower)) return { operation: 'set_detail', detail: 'high' };
  if (/\btaller\b/.test(lower)) return { operation: 'stretch', axis: 'y', factor: 1.4 };
  if (/\bwider\b/.test(lower)) return { operation: 'stretch', axis: 'x', factor: 1.4 };
  if (/flatten|squash|flatter/.test(lower)) return { operation: 'stretch', axis: 'y', factor: 0.6 };
  if (/rotate|turn it|spin/.test(lower)) return { operation: 'rotate', axis: 'y', degrees: 22.5 };
  const primitive = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane'].find((type) => new RegExp(`(?:in)?to an? ${type}`).test(lower));
  if (primitive) return { operation: 'set_type', type: primitive };
  return { operation: 'stretch', axis: 'y', factor: 1.25 };
}

function styleFrom(lower) {
  if (/futur|sci[ -]?fi|cyber|space/.test(lower)) return 'Futuristic';
  if (/minimal|simple|clean/.test(lower)) return 'Minimal';
  if (/industrial|heavy|utility/.test(lower)) return 'Industrial';
  return 'Exploratory';
}

function semanticQuery(text) {
  return text.replace(/^(find|where (?:is|are)|show me)\s+/i, '').replace(/[?!.]+$/, '').trim() || text;
}

function extractVersionName(text) {
  const match = text.match(/(?:called|named)\s+["“']?([^"”']+)["”']?/i);
  return match?.[1]?.trim() || 'Agent checkpoint';
}

function extractCommentText(text) {
  const match = text.match(/(?:comment|note|annotation)\s*[:\-]?\s*(.+)$/i);
  return match?.[1]?.trim() || text;
}

function extractPersona(lower) {
  if (/engineer/.test(lower)) return 'Geometry engineer';
  if (/reviewer/.test(lower)) return 'Design reviewer';
  if (/designer/.test(lower)) return 'Visual designer';
  return 'Adaptive co-designer';
}

function extractPreference(text) {
  return text
    .replace(/^\s*(?:please\s+)?(?:remember(?:\s+that)?|forget(?:\s+that)?|remove(?:\s+my)?\s+preference(?:\s+for)?)\s*/i, '')
    .replace(/^\s*(?:i\s+(?:like|prefer)|always\s+use|my\s+style\s+is)\s*/i, '')
    .replace(/[.?!]+$/, '')
    .trim() || 'low-poly, purposeful forms';
}

/*
 * Pull the checkpoint the human actually named out of a restore request. Generic words
 * such as "version" or "checkpoint" stay in the string; the caller strips them when it
 * scores candidate labels, so "restore checkpoint 2" cannot match "checkpoint 3".
 */
export function extractRestoreTarget(text) {
  return String(text || '')
    .replace(/^\s*(?:please\s+)?(?:can you\s+)?(?:restore|revert|roll ?back|go back|return)\s*/i, '')
    .replace(/^\s*(?:to|the|me to)\s+/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
}
