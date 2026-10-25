// Workflows saved from the 0.3.0 template or earlier bypass their optional
// branches and mark them with bno84.enabledInput. Their If/Else switches are
// driven by the same wires, so re-enabling the branch keeps routing correct.
// Without this, a branch saved as bypassed would ignore later control changes.
import { app } from "../../scripts/app.js";

const MARKER = "bno84.enabledInput";
const BYPASS = 4;

export function migrateLegacyBranch(node) {
  if (!node.properties?.[MARKER]) return false;
  delete node.properties[MARKER];
  // Only the old toggle set bypass on these; keep a deliberate mute.
  if (node.mode === BYPASS) node.mode = 0;
  return true;
}

app.registerExtension({
  name: "bno84.LegacyBypass",
  nodeCreated(node) {
    // Properties arrive in configure, after creation: on load, on paste, and
    // for nodes inside subgraph definitions.
    const configure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = configure?.apply(this, args);
      if (migrateLegacyBranch(this)) {
        console.info(`YuE2-Kit: re-enabled legacy bypassed branch "${this.title ?? this.id}".`);
      }
      return result;
    };
  },
});
