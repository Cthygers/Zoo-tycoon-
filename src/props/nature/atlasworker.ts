// Web worker: paints foliage atlases off the main thread for the loading
// screen (see paintAtlasesOffThread in atlases.ts). Receives an atlas kind,
// answers with its mip chain (pixel buffers transferred, not copied).
import { paintAtlas, type AtlasKind } from './atlases';

const scope = self as unknown as Worker;
scope.onmessage = (e: MessageEvent<AtlasKind>) => {
  const mips = paintAtlas(e.data);
  scope.postMessage({ kind: e.data, mips }, mips.map((m) => m.data.buffer));
};
