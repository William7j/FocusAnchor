export type DocumentKind = 'epub' | 'pdf' | 'text' | 'markdown' | 'docx';
export type ThemeName = 'paper' | 'night' | 'sepia';
export type FocusMode = 'off' | 'paragraph';
export type WereadAssistMode = 'off' | 'ruler' | 'paragraph';
export type AnnotationColor = 'sun' | 'mint' | 'sky' | 'rose';

export interface DocumentRecord {
  id: string;
  assetId: string;
  checksum: string;
  title: string;
  sourceName: string;
  kind: DocumentKind;
  mimeType: string;
  size: number;
  importedAt: number;
  lastOpenedAt: number;
}

export type AnnotationLocator =
  | { kind: 'flow'; blockId: string; start: number; end: number }
  | { kind: 'epub'; cfi: string }
  | { kind: 'pdf'; page: number; rects: Array<{ x: number; y: number; width: number; height: number }> };

export interface AnnotationRecord {
  id: string;
  documentId: string;
  locator: AnnotationLocator;
  quote: string;
  color: AnnotationColor;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReadingPosition {
  documentId: string;
  locator: string;
  progress: number;
  updatedAt: number;
}

export interface ReaderPreferences {
  theme: ThemeName;
  fontSize: number;
  lineHeight: number;
  columnWidth: number;
  pageMargin: number;
  focusMode: FocusMode;
  sentenceHighlight: boolean;
}

export interface LocalSentenceState {
  count: number;
  activeIndex: number;
}

export interface ReaderCatalogItem {
  id: string;
  label: string;
  level: number;
  locator: string;
}

export interface WereadAssistPreferences {
  mode: WereadAssistMode;
  dimming: number;
  bandHeight: number;
  followPointer: boolean;
  showGuideLine: boolean;
  sentenceHighlight: boolean;
}

export type WereadAssistDiagnosticStatus = 'scanning' | 'ready' | 'unsupported' | 'error';
export type WereadAssistDiagnosticSource = 'none' | 'dom' | 'canvas';

export interface WereadAssistDiagnostics {
  status: WereadAssistDiagnosticStatus;
  source: WereadAssistDiagnosticSource;
  detected: boolean;
  sentences: number;
  blocks: number;
  reason: string;
}

export type PreferenceRecord =
  | { key: 'reader'; value: ReaderPreferences }
  | { key: 'weread-assist'; value: WereadAssistPreferences };

export type WereadAssistAction =
  | { type: 'recenter' }
  | { type: 'move'; direction: -1 | 1 }
  | { type: 'move-sentence'; direction: -1 | 1 }
  | { type: 'auto-scroll'; active: boolean; speed: number };

export interface ImportedAsset {
  assetId: string;
  checksum: string;
  kind: DocumentKind;
  mimeType: string;
  sourceName: string;
  title: string;
  size: number;
  duplicate: boolean;
}

export interface NativeImportResult {
  imported: ImportedAsset[];
  failures: Array<{ name: string; message: string }>;
}

export interface NativeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowBlock {
  id: string;
  html: string;
  text: string;
  type: string;
}

export interface SelectionDraft {
  locator: AnnotationLocator;
  quote: string;
}

declare global {
  interface Window {
    readerNative?: {
      library: {
        importDocuments: () => Promise<NativeImportResult | []>;
        exportNotes: (payload: { content: string; format: 'markdown' | 'json'; suggestedName: string }) => Promise<{ saved: boolean }>;
        deleteDocument: (payload: { assetId: string }) => Promise<{ deleted: boolean }>;
      };
      weread: {
        open: (bounds: NativeBounds) => Promise<{ visible: boolean; hasSession: boolean }>;
        hide: () => Promise<{ visible: boolean; hasSession: boolean }>;
        setBounds: (bounds: NativeBounds) => Promise<void>;
        login: () => Promise<{ visible: boolean; hasSession: boolean }>;
        importCookie: (payload: { format: 'header' | 'json'; value: string }) => Promise<{ imported: number }>;
        logout: () => Promise<{ visible: boolean; hasSession: boolean }>;
        status: () => Promise<{ visible: boolean; hasSession: boolean }>;
        setAssist: (settings: WereadAssistPreferences) => Promise<WereadAssistPreferences>;
        assistAction: (action: WereadAssistAction) => Promise<void>;
        onAssistDiagnostics: (listener: (value: WereadAssistDiagnostics) => void) => () => void;
      };
    };
  }
}
