/**
 * 只读 PLY 头部，判断文件类型，避免把网格/点云交给 3DGS 解码器。
 * 头部是 ASCII，读前 1 MB 足够覆盖正常 PLY。
 */

export function parsePlyHeader(text) {
  const end = text.indexOf("end_header");
  if (end < 0) {
    throw new Error("找不到 end_header：不是 PLY，或头部超过 1 MB");
  }

  const lines = text
    .slice(0, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0]?.toLowerCase() !== "ply") {
    throw new Error("不是 PLY 文件");
  }

  let format = "";
  let vertexCount = 0;
  let faceCount = 0;
  let currentElement = "";
  const vertexProps = [];
  const faceProps = [];

  for (const line of lines) {
    if (line.startsWith("format ")) {
      format = line.split(/\s+/)[1] || "";
    } else if (line.startsWith("element ")) {
      const [, name, count] = line.split(/\s+/);
      currentElement = name;
      if (name === "vertex") vertexCount = Number(count) || 0;
      if (name === "face") faceCount = Number(count) || 0;
    } else if (line.startsWith("property ")) {
      const parts = line.split(/\s+/);
      const name = parts[parts.length - 1];
      if (currentElement === "vertex") vertexProps.push(name);
      if (currentElement === "face") faceProps.push(name);
    }
  }

  if (!format) throw new Error("PLY 头部缺少 format");
  if (!vertexCount) throw new Error("PLY 没有顶点");

  const props = new Set(vertexProps);
  const has3DGS = ["f_dc_0", "opacity", "scale_0", "rot_0"].every((name) =>
    props.has(name),
  );
  const hasNormals = ["nx", "ny", "nz"].every((name) => props.has(name));
  const hasColors =
    ["red", "green", "blue"].every((name) => props.has(name)) ||
    ["diffuse_red", "diffuse_green", "diffuse_blue"].every((name) =>
      props.has(name),
    );

  return {
    format,
    vertexCount,
    faceCount,
    vertexProps,
    faceProps,
    has3DGS,
    hasNormals,
    hasColors,
    type: has3DGS ? "3dgs" : faceCount > 0 ? "mesh" : "points",
  };
}

export async function readPlyHeader(file) {
  if (!file || !file.size) throw new Error("空文件");
  const chunk = file.slice(0, Math.min(file.size, 1 << 20));
  return parsePlyHeader(await chunk.text());
}
