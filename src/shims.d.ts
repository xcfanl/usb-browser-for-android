declare module 'mammoth/mammoth.browser.min.js' {
  const mammoth: {
    convertToHtml: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }>
  }
  export default mammoth
}
declare module '*?url' {
  const url: string
  export default url
}
