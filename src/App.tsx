import React, { useState, useCallback } from 'react';
import { 
  DndContext, 
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { 
  FileText, 
  GripVertical, 
  X, 
  Upload, 
  File as FileIcon, 
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import mammoth from 'mammoth';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface FileItem {
  id: string;
  file: File;
  name: string;
  type: string;
}

interface SortableItemProps {
  id: string;
  name: string;
  type: string;
  onRemove: (id: string) => void;
  key?: React.Key;
}

const SortableFileItem = ({ id, name, type, onRemove }: SortableItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  const getFileIcon = () => {
    if (type.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
    if (type.includes('word') || name.endsWith('.docx') || name.endsWith('.doc')) return <FileIcon className="w-5 h-5 text-blue-500" />;
    return <FileText className="w-5 h-5 text-gray-500" />;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 p-3 bg-white border border-zinc-200 rounded-xl shadow-sm mb-2 group",
        isDragging && "opacity-50 shadow-lg border-zinc-300"
      )}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 hover:bg-zinc-100 rounded transition-colors"
      >
        <GripVertical className="w-4 h-4 text-zinc-400" />
      </button>
      
      <div className="flex-shrink-0">
        {getFileIcon()}
      </div>
      
      <div className="flex-grow min-w-0">
        <p className="text-sm font-medium text-zinc-900 truncate">{name}</p>
        <p className="text-xs text-zinc-500 uppercase">{type.split('/')[1] || name.split('.').pop()}</p>
      </div>

      <button
        onClick={() => onRemove(id)}
        className="p-1.5 hover:bg-red-50 text-zinc-400 hover:text-red-500 rounded-lg transition-all opacity-0 group-hover:opacity-100"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [outputName, setOutputName] = useState('merged_document');
  const [isMerging, setIsMerging] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null; message: string }>({ type: null, message: '' });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files) as File[];
    addFiles(droppedFiles);
  }, []);

  const addFiles = (newFiles: File[]) => {
    const validFiles = newFiles.filter(file => {
      const ext = file.name.split('.').pop()?.toLowerCase();
      return ['pdf', 'txt', 'docx', 'doc'].includes(ext || '');
    });

    const newFileItems = validFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      name: file.name,
      type: file.type || 'application/octet-stream'
    }));

    setFiles(prev => [...prev, ...newFileItems]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(Array.from(e.target.files));
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setFiles((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleMerge = async () => {
    if (files.length === 0) return;

    setIsMerging(true);
    setStatus({ type: null, message: '' });

    try {
      const mergedPdf = await PDFDocument.create();
      mergedPdf.registerFontkit(fontkit);
      
      // Fetch CJK font
      const FONT_URL = "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf";
      let fontBytes: ArrayBuffer | null = null;
      try {
        const fontRes = await fetch(FONT_URL);
        if (fontRes.ok) fontBytes = await fontRes.arrayBuffer();
      } catch (e) {
        console.warn("Could not load CJK font, falling back to standard font", e);
      }

      let addedPagesCount = 0;

      for (const item of files) {
        const file = item.file;
        let pdfBytes: Uint8Array;

        if (file.type === "application/pdf" || file.name.toLowerCase().endsWith('.pdf')) {
          pdfBytes = new Uint8Array(await file.arrayBuffer());
        } else {
          let text = "";
          if (file.type === "text/plain" || file.name.toLowerCase().endsWith('.txt')) {
            text = await file.text();
          } else if (
            file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
            file.name.toLowerCase().endsWith(".docx") ||
            file.name.toLowerCase().endsWith(".doc")
          ) {
            const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            text = result.value;
          } else {
            continue;
          }

          // Sanitize text
          text = text
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .replace(/[^\x20-\x7E\u00A0-\u00FF\u0100-\u017F\u0180-\u024F\u0370-\u03FF\u0400-\u04FF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\n\t]/g, "");

          const textPdf = await PDFDocument.create();
          textPdf.registerFontkit(fontkit);
          
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
            y -= fontSize * 1.4;
          }
          pdfBytes = await textPdf.save();
        }

        const donorPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const copiedPages = await mergedPdf.copyPages(donorPdf, donorPdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
        addedPagesCount += copiedPages.length;
      }

      if (addedPagesCount === 0) {
        throw new Error("No valid pages were added to the PDF.");
      }

      const mergedPdfBytes = await mergedPdf.save();
      const blob = new Blob([mergedPdfBytes], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const downloadName = outputName.toLowerCase().endsWith('.pdf') ? outputName : `${outputName}.pdf`;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setStatus({ type: 'success', message: 'PDF merged and downloaded successfully!' });
    } catch (error: any) {
      console.error(error);
      setStatus({ type: 'error', message: error.message || 'An error occurred during merging. Please try again.' });
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 font-sans p-6 md:p-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
          <header className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-3 bg-gradient-to-r from-zinc-900 to-zinc-600 bg-clip-text text-transparent">
            PDF 整合工具
          </h1>
          <p className="text-zinc-500">Merge PDF, Word (最好先利用WORD本身功能轉成PDF檔), and Text files</p>
        </header>

        <div className="grid gap-8">
          {/* Upload Area */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="relative group"
          >
            <input
              type="file"
              multiple
              accept=".pdf,.txt,.docx,.doc"
              onChange={handleFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              id="file-upload"
            />
            <div className="border-2 border-dashed border-zinc-200 rounded-3xl p-12 text-center bg-white transition-all group-hover:border-zinc-400 group-hover:bg-zinc-50/50">
              <div className="w-16 h-16 bg-zinc-100 rounded-2xl flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                <Upload className="w-8 h-8 text-zinc-600" />
              </div>
              <h3 className="text-lg font-semibold mb-1">Drop files here or click to upload</h3>
              <p className="text-sm text-zinc-400">Supports PDF, TXT, and DOCX</p>
            </div>
          </div>

          {/* File List & Sorting */}
          {files.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-3xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  Files to Merge
                  <span className="text-xs font-normal bg-zinc-100 px-2 py-0.5 rounded-full text-zinc-500">
                    {files.length}
                  </span>
                </h2>
                <button 
                  onClick={() => setFiles([])}
                  className="text-xs text-zinc-400 hover:text-red-500 transition-colors"
                >
                  Clear all
                </button>
              </div>

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={files.map(f => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {files.map((file) => (
                      <SortableFileItem
                        key={file.id}
                        id={file.id}
                        name={file.name}
                        type={file.type}
                        onRemove={removeFile}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              <div className="mt-8 pt-6 border-t border-zinc-100">
                <div className="grid gap-4">
                  <div>
                    <label htmlFor="output-name" className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                      Output Filename
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        id="output-name"
                        value={outputName}
                        onChange={(e) => setOutputName(e.target.value)}
                        className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-zinc-900/5 transition-all"
                        placeholder="Enter filename..."
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">.pdf</span>
                    </div>
                  </div>

                  <button
                    onClick={handleMerge}
                    disabled={isMerging || files.length === 0}
                    className={cn(
                      "w-full py-4 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all",
                      isMerging || files.length === 0
                        ? "bg-zinc-100 text-zinc-400 cursor-not-allowed"
                        : "bg-zinc-900 text-white hover:bg-zinc-800 active:scale-[0.98] shadow-lg shadow-zinc-900/10"
                    )}
                  >
                    {isMerging ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Download className="w-5 h-5" />
                        Merge & Download
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Status Messages */}
          {status.type && (
            <div className={cn(
              "p-4 rounded-2xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2",
              status.type === 'success' ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : "bg-red-50 text-red-700 border border-red-100"
            )}>
              {status.type === 'success' ? <CheckCircle2 className="w-5 h-5 mt-0.5" /> : <AlertCircle className="w-5 h-5 mt-0.5" />}
              <p className="text-sm font-medium">{status.message}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="mt-20 text-center border-t border-zinc-200 pt-8">
          <p className="text-xs text-zinc-400 uppercase tracking-widest">
            A custom-built program for Yanjun and Rita @ 2026.
          </p>
        </footer>
      </div>
    </div>
  );
}
