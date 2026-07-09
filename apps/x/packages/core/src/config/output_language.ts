// believe: idioma de salida forzado para TODO el contenido generado por LLM en la app.
// Fuente única: config/note_creation.json campo "language" (ej. "Spanish").
// La UI queda en inglés; solo el contenido generado por el modelo sale en el idioma configurado.
import { getNoteLanguage } from './note_creation_config.js';

/**
 * believe: idioma de salida configurado, o undefined si no hay ninguno (= default del modelo).
 * Reutiliza getNoteLanguage() para que haya una sola fuente de verdad.
 */
export function getOutputLanguage(): string | undefined {
  return getNoteLanguage();
}

/**
 * believe: devuelve una directiva fuerte (en inglés, para el modelo) que fuerza a escribir
 * TODO el output en el idioma configurado, sin importar el idioma del material fuente.
 * Devuelve "" si no hay idioma configurado, para poder concatenarla sin efecto.
 *
 * @param contextLabel texto que describe qué se genera (ej. "the chat reply",
 *   "the meeting summary"). Se inserta en la directiva para que el modelo sepa a qué aplica.
 */
export function languageDirective(contextLabel: string): string {
  const lang = getOutputLanguage();
  if (!lang) return '';
  return `\n\n**Output language (mandatory):** Write ALL of ${contextLabel} in ${lang}, regardless of the language of the source material. Even if the source (emails, transcripts, notes, messages) is in another language, your generated output MUST be in ${lang}. Preserve proper nouns, people/organization names, code, file paths, and wikilink targets (\`[[...]]\`) exactly as they are; translate everything else. This is not optional.`;
}
