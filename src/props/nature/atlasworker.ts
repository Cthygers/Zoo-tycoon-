// Web worker: paints foliage atlases off the main thread for the loading
// screen (see paintAtlasesOffThread in atlases.ts). Receives an atlas kind,
// answers with its mip chain (pixel buffers transferred, not copied), or with
// the error, so the main thread paints that atlas itself instead of waiting.
import { paintAtlas, type AtlasKind, type AtlasWorkerReply } from './atlases';

const scope = self as unknown as Worker;
scope.onmessage = (e: MessageEvent<AtlasKind>) => {
  const kind = e.data;
  let mips;
  try {
    mips = paintAtlas(kind);
  } catch (err) {
    scope.postMessage({ kind, error: String(err) } satisfies AtlasWorkerReply);
    return;
  }
  scope.postMessage({ kind, mips } satisfies AtlasWorkerReply, mips.map((m) => m.data.buffer));
};
