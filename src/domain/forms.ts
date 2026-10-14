import { z } from 'zod';

/**
 * The form members fill in for a ticket type. A Discord form holds at most five sections:
 * optional intro text, the title and description every ticket needs, and the admins' own
 * questions (short answer, paragraph or file upload).
 */
export const FORM_MAX_SECTIONS = 5;
export const MAX_FILES_LIMIT = 10;

export type SectionKind = 'intro' | 'title' | 'description' | 'short' | 'paragraph' | 'files';
export const CUSTOM_KINDS = ['short', 'paragraph', 'files'] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

export const KIND_NAMES: Record<SectionKind, string> = {
  intro: 'Intro text',
  title: 'Title',
  description: 'Description',
  short: 'Short answer',
  paragraph: 'Paragraph',
  files: 'File upload',
};

/** Discord limits: Label label 45, Label description 100, text input placeholder 100. */
export const LIMITS = { label: 45, hint: 100, placeholder: 100, intro: 1000, short: 300, paragraph: 2000 } as const;

export interface FormSection {
  /** "intro", "title", "description", or a random key for the admins' own questions. */
  key: string;
  kind: SectionKind;
  label: string;
  hint: string;
  placeholder: string;
  /** Intro only. */
  text: string;
  /** Own questions only; the title and description are always required. */
  required: boolean;
  /** File upload only. */
  maxFiles: number;
}

const SectionSchema = z.object({
  key: z.string(),
  kind: z.enum(['intro', 'title', 'description', 'short', 'paragraph', 'files']),
  label: z.string().catch(''),
  hint: z.string().catch(''),
  placeholder: z.string().catch(''),
  text: z.string().catch(''),
  required: z.boolean().catch(false),
  maxFiles: z.number().int().catch(5),
});

export const DEFAULT_GUIDANCE = 'When it applies, include the steps to reproduce it, what you expected to happen and what actually happened.';
export const FILES_HINT = 'Up to 5 PNG or JPG images, 10 MB in total. Hide anything private first.';

const KEY = /^[a-z0-9]{2,12}$/;

export function isBugLike(t: { name: string; label?: string | null }): boolean {
  return /bug|error|crash|broken|defect/i.test(`${t.name} ${t.label ?? ''}`);
}

function section(kind: SectionKind, key: string, o: Partial<FormSection> = {}): FormSection {
  return { key, kind, label: '', hint: '', placeholder: '', text: '', required: false, maxFiles: 5, ...o };
}

type TypeLike = { name: string; label?: string | null; guidance?: string | null; placeholder?: string | null };

/** The form used until an admin saves their own. Bug reports also ask for the OS and screenshots. */
export function defaultForm(type: TypeLike | null): FormSection[] {
  const base = [
    section('intro', 'intro', { text: type?.guidance?.trim() || DEFAULT_GUIDANCE }),
    section('title', 'title', { label: 'Title', hint: 'A short summary of the problem.', placeholder: 'e.g. Export button does nothing on the reports page' }),
    section('description', 'description', {
      label: 'Description',
      hint: type ? 'The details that help the team act on it.' : 'Steps to reproduce, expected behavior and actual behavior.',
      placeholder: type?.placeholder?.trim() || '1. Go to…  2. Click…  Expected: …  Actual: …',
    }),
  ];
  if (!type || !isBugLike(type)) return base;
  return [
    ...base,
    section('short', 'os', { label: 'Operating system and version', hint: 'Add the version if you know it.', placeholder: 'e.g. Windows 11, macOS 15.2, iOS 18', required: true }),
    section('files', 'shots', { label: 'Screenshots', hint: FILES_HINT, maxFiles: 5 }),
  ];
}

/** The form for a ticket type: the saved one, or the default when none is saved (or it's unreadable). */
export function formFor(type: (TypeLike & { form?: unknown }) | null): FormSection[] {
  if (type?.form) {
    const parsed = z.array(SectionSchema).safeParse(type.form);
    if (parsed.success && !validateForm(parsed.data).length) return parsed.data;
  }
  return defaultForm(type);
}

/** Problems that would stop Discord from showing the form, or that break filing. */
export function validateForm(sections: FormSection[]): string[] {
  const errors: string[] = [];
  const count = (k: SectionKind) => sections.filter((s) => s.kind === k).length;
  if (sections.length > FORM_MAX_SECTIONS) errors.push(`Discord forms hold at most ${FORM_MAX_SECTIONS} sections. Remove ${sections.length - FORM_MAX_SECTIONS}.`);
  if (count('title') !== 1) errors.push('The form needs exactly one Title section.');
  if (count('description') !== 1) errors.push('The form needs exactly one Description section.');
  if (count('intro') > 1) errors.push('Only one intro text is allowed.');
  if (count('intro') === 1 && sections[0]?.kind !== 'intro') errors.push('The intro text must be the first section.');
  if (count('files') > 1) errors.push('Only one file upload is allowed.');
  const keys = new Set<string>();
  for (const s of sections) {
    const builtIn = s.kind === 'intro' || s.kind === 'title' || s.kind === 'description';
    if (builtIn ? s.key !== s.kind : !KEY.test(s.key) || ['intro', 'title', 'description'].includes(s.key)) errors.push('A section has an invalid ID. Reload the page and try again.');
    if (keys.has(s.key)) errors.push('Two sections have the same ID. Reload the page and try again.');
    keys.add(s.key);
    const name = s.label.trim() || KIND_NAMES[s.kind];
    if (s.kind === 'intro') {
      if (!s.text.trim()) errors.push('The intro text is empty. Write something or remove it.');
      if (s.text.length > LIMITS.intro) errors.push(`Keep the intro text under ${LIMITS.intro} characters.`);
      continue;
    }
    if (!s.label.trim()) errors.push(`Every ${KIND_NAMES[s.kind].toLowerCase()} needs a question.`);
    if (s.label.length > LIMITS.label) errors.push(`“${name}”: Discord allows questions up to ${LIMITS.label} characters.`);
    if (s.hint.length > LIMITS.hint) errors.push(`“${name}”: keep the hint under ${LIMITS.hint} characters.`);
    if (s.placeholder.length > LIMITS.placeholder) errors.push(`“${name}”: keep the placeholder under ${LIMITS.placeholder} characters.`);
    if (s.kind === 'files' && (s.maxFiles < 1 || s.maxFiles > MAX_FILES_LIMIT)) errors.push(`“${name}”: members can attach 1 to ${MAX_FILES_LIMIT} files.`);
  }
  return [...new Set(errors)];
}

/** Text a section answer can be (the description has its own limit). */
export function answerMax(kind: SectionKind): number {
  return kind === 'paragraph' ? LIMITS.paragraph : LIMITS.short;
}

/** Discord custom_id for an own question or file upload. */
export function questionId(key: string): string {
  return `q:${key}`;
}
export function filesId(key: string): string {
  return `f:${key}`;
}
