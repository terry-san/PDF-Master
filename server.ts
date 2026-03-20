import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import mammoth from "mammoth";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // URL for a CJK font (Noto Sans TC)
  const FONT_URL = "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf";
  let fontPromise: Promise<ArrayBuffer | null> | null = null;

  async function getFontBytes() {
    if (fontPromise) return fontPromise;
    
    fontPromise = (async () => {
      try {
        console.log("Fetching CJK font...");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        const response = await fetch(FONT_URL, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`Failed to fetch font: ${response.statusText}`);
        const bytes = await response.arrayBuffer();
        console.log("CJK font fetched successfully.");
        return bytes;
      } catch (err) {
        console.error("Error loading CJK font, falling back to standard font:", err);
        return null;
      }
    })();
    
    return fontPromise;
  }

  // Configure multer for memory storage with increased limits
  const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB per file
      files: 50
    }
  });

  app.use(express.json());

  // API Route for merging
  app.post("/api/merge", upload.array("files"), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      const outputName = req.body.outputName || "merged.pdf";

      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files received by the server." });
      }

      // The files are already appended in order by the client
      const orderedFiles = files;

      const mergedPdf = await PDFDocument.create();
      let addedPagesCount = 0;

      console.log(`Starting merge for ${files.length} files...`);

      for (let i = 0; i < orderedFiles.length; i++) {
        const file = orderedFiles[i];
        console.log(`[${i + 1}/${files.length}] Processing: ${file.originalname} (${file.mimetype})`);
        let pdfBytes: Uint8Array;

        if (file.mimetype === "application/pdf") {
          pdfBytes = new Uint8Array(file.buffer);
        } else {
          let text = "";
          if (file.mimetype === "text/plain") {
            text = file.buffer.toString("utf-8");
          } else if (
            file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
            file.mimetype === "application/msword" ||
            file.originalname.toLowerCase().endsWith(".docx") ||
            file.originalname.toLowerCase().endsWith(".doc")
          ) {
            try {
              console.log(`Extracting text from Word file: ${file.originalname}...`);
              // mammoth is much more robust for docx with images/tables
              const result = await mammoth.extractRawText({ buffer: file.buffer });
              text = result.value;
              console.log(`Extraction successful (${text.length} characters).`);
              
              if (result.messages.length > 0) {
                console.log("Extraction messages:", result.messages);
              }
            } catch (err) {
              console.error(`Word extraction failed for ${file.originalname}:`, err);
              continue;
            }
          } else {
            console.warn(`Unsupported file type: ${file.mimetype}`);
            continue;
          }

          // Sanitize text: remove non-printable characters and normalize line endings
          // This prevents pdf-lib from crashing or producing corrupt PDFs
          text = text
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[^\x20-\x7E\u00A0-\u00FF\u0100-\u017F\u0180-\u024F\u0370-\u03FF\u0400-\u04FF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\n\t]/g, "");

          // Create a new PDF for the text content using pdf-lib
          const textPdf = await PDFDocument.create();
          textPdf.registerFontkit(fontkit);
          
          const fontBytes = await getFontBytes();
          let font;
          if (fontBytes) {
            font = await textPdf.embedFont(fontBytes);
          } else {
            font = await textPdf.embedFont(StandardFonts.Helvetica);
          }

          const fontSize = 12;
          const margin = 50;
          
          let page = textPdf.addPage();
          const { width, height } = page.getSize();
          
          const maxWidth = width - margin * 2;
          
          // Improved text splitting to handle CJK characters (no spaces needed)
          const splitTextIntoLines = (text: string, font: any, size: number, maxWidth: number) => {
            const lines: string[] = [];
            let currentLine = "";
            
            for (const char of text) {
              if (char === '\n') {
                lines.push(currentLine);
                currentLine = "";
                continue;
              }
              
              const testLine = currentLine + char;
              const testWidth = font.widthOfTextAtSize(testLine, size);
              
              if (testWidth > maxWidth && currentLine !== "") {
                lines.push(currentLine);
                currentLine = char;
              } else {
                currentLine = testLine;
              }
            }
            if (currentLine) lines.push(currentLine);
            return lines;
          };

          const lines = splitTextIntoLines(text, font, fontSize, maxWidth);
          let y = height - margin;

          for (const line of lines) {
            if (y < margin) {
              page = textPdf.addPage();
              y = height - margin;
            }
            page.drawText(line, { x: margin, y, size: fontSize, font });
            y -= fontSize * 1.4; // Slightly more line spacing for CJK
          }
          
          pdfBytes = await textPdf.save();
        }

        try {
          const donorPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const copiedPages = await mergedPdf.copyPages(donorPdf, donorPdf.getPageIndices());
          copiedPages.forEach((page) => mergedPdf.addPage(page));
          addedPagesCount += copiedPages.length;
        } catch (loadError) {
          console.error(`Error loading file ${file.originalname}:`, loadError);
        }
      }

      if (addedPagesCount === 0) {
        return res.status(400).json({ error: "Could not extract any valid pages from the provided files." });
      }

      const mergedPdfBytes = await mergedPdf.save();
      const safeOutputName = outputName.replace(/\.pdf$/i, "") || "merged";

      console.log(`Merge complete. Final size: ${(mergedPdfBytes.length / 1024 / 1024).toFixed(2)} MB`);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeOutputName)}.pdf"`);
      res.setHeader("Content-Length", mergedPdfBytes.length);
      res.end(Buffer.from(mergedPdfBytes));
    } catch (error) {
      console.error("Merge error:", error);
      res.status(500).json({ error: "Failed to merge files" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
