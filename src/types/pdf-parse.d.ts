declare module 'pdf-parse' {
  interface PdfData {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    text: string;
    version: string;
  }

  interface PdfOptions {
    max?: number;
    pagerender?(pageData: any): Promise<string>;
  }

  function pdfParse(buffer: Buffer, options?: PdfOptions): Promise<PdfData>;
  export default pdfParse;
}
