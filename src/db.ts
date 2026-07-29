import Dexie, { type EntityTable } from 'dexie';
import type { AnnotationRecord, DocumentRecord, PreferenceRecord, ReaderPreferences, ReadingPosition, WereadAssistPreferences } from './types';

export const defaultPreferences: ReaderPreferences = {
  theme: 'paper',
  fontSize: 20,
  lineHeight: 1.9,
  columnWidth: 720,
  pageMargin: 56,
  focusMode: 'off',
  sentenceHighlight: true,
};

export const defaultWereadAssistPreferences: WereadAssistPreferences = {
  mode: 'off',
  dimming: 0.52,
  bandHeight: 150,
  followPointer: true,
  showGuideLine: true,
  sentenceHighlight: true,
};

class ReaderDatabase extends Dexie {
  documents!: EntityTable<DocumentRecord, 'id'>;
  positions!: EntityTable<ReadingPosition, 'documentId'>;
  annotations!: EntityTable<AnnotationRecord, 'id'>;
  preferences!: EntityTable<PreferenceRecord, 'key'>;

  constructor() {
    super('focus-reader');
    this.version(1).stores({
      documents: 'id, &checksum, importedAt, lastOpenedAt, kind',
      positions: 'documentId, updatedAt',
      annotations: 'id, documentId, createdAt, updatedAt',
      preferences: 'key',
    });
  }
}

export const db = new ReaderDatabase();

export async function getPreferences() {
  const stored = await db.preferences.get('reader');
  return { ...defaultPreferences, ...(stored?.key === 'reader' ? stored.value : undefined) };
}

export async function savePreferences(value: ReaderPreferences) {
  await db.preferences.put({ key: 'reader', value });
}

export async function getWereadAssistPreferences() {
  const stored = await db.preferences.get('weread-assist');
  return { ...defaultWereadAssistPreferences, ...(stored?.key === 'weread-assist' ? stored.value : undefined) };
}

export async function saveWereadAssistPreferences(value: WereadAssistPreferences) {
  await db.preferences.put({ key: 'weread-assist', value });
}

export async function savePosition(position: ReadingPosition) {
  await db.positions.put(position);
}
