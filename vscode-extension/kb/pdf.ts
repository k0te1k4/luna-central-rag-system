import * as vscode from 'vscode';

/**
 * Best-effort PDF -> text extraction.
 * Uses pdf-parse (pdf.js) under the hood.
 */
export async function extractPdfText(pdfUri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(pdfUri);
  // Dynamic import keeps activation faster.
  const pdfParse = (await import('pdf-parse')).default as any;
  const res = await pdfParse(Buffer.from(bytes));
  const text = String(res?.text || '').replace(/\r\n/g, '\n');
  return normalizeExtractedText(text);
}

function normalizeExtractedText(text: string): string {
  let s = text;
  // Remove excessive whitespace, keep paragraph breaks.
  s = s.replace(/\u00a0/g, ' ');
  // Fix hyphenation: "word-\nnext" -> "wordnext"
  s = s.replace(/([A-Za-zА-Яа-яЁё])\-\n([A-Za-zА-Яа-яЁё])/g, '$1$2');
  // Normalize multiple blank lines.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
