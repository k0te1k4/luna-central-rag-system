declare module 'pdf-parse' {
  type PdfParseResult = {
    numpages?: number;
    numrender?: number;
    info?: any;
    metadata?: any;
    text: string;
    version?: string;
  };

  interface PdfParseOptions {
    pagerender?: (pageData: any) => any;
    max?: number;
    version?: string;
  }

  function pdfParse(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>;
  export default pdfParse;
}
