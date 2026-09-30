const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const readerFor = source => {
  let fullBuffer = null;
  return async (start, end) => {
    if (source instanceof Blob) return source.slice(start, end).arrayBuffer();
    if (fullBuffer) return fullBuffer.slice(start, end);
    const response = await fetch(source, {headers:{Range:`bytes=${start}-${end-1}`}});
    if (!response.ok) throw new Error(`VRMを取得できませんでした (${response.status})`);
    const buffer = await response.arrayBuffer();
    if (response.status === 206) return buffer;
    fullBuffer = buffer;
    return fullBuffer.slice(start, end);
  };
};

const imageIndexFrom = json => {
  const vrm1 = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
  if (Number.isInteger(vrm1)) return vrm1;
  const texture = json.extensions?.VRM?.meta?.texture;
  if (!Number.isInteger(texture)) return null;
  const source = json.textures?.[texture]?.source;
  return Number.isInteger(source) ? source : null;
};

const decodeDataUri = async uri => {
  const response = await fetch(uri);
  return response.ok ? response.blob() : null;
};

export const extractVrmThumbnail = async source => {
  const read = readerFor(source);
  const header = await read(0, 20);
  if (header.byteLength < 20) return null;
  const view = new DataView(header);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(16, true) !== JSON_CHUNK) return null;
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = await read(20, 20 + jsonLength);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes).replace(/\u0000+$/g, '').trimEnd());
  const imageIndex = imageIndexFrom(json);
  if (imageIndex === null) return null;
  const image = json.images?.[imageIndex];
  if (!image) return null;

  if (image.uri) {
    if (image.uri.startsWith('data:')) return decodeDataUri(image.uri);
    if (typeof source === 'string') {
      const response = await fetch(new URL(image.uri, source));
      return response.ok ? response.blob() : null;
    }
    return null;
  }

  if (!Number.isInteger(image.bufferView)) return null;
  const bufferView = json.bufferViews?.[image.bufferView];
  if (!bufferView || (bufferView.buffer ?? 0) !== 0) return null;
  const binHeaderOffset = 20 + jsonLength;
  const binHeader = await read(binHeaderOffset, binHeaderOffset + 8);
  if (binHeader.byteLength < 8 || new DataView(binHeader).getUint32(4, true) !== BIN_CHUNK) return null;
  const start = binHeaderOffset + 8 + (bufferView.byteOffset || 0);
  const bytes = await read(start, start + bufferView.byteLength);
  return new Blob([bytes], {type:image.mimeType || 'application/octet-stream'});
};
