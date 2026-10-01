/** 브라우저가 MIME을 비워 주는 경우가 있어 확장자도 함께 확인한다. */
export function isPngFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
}
