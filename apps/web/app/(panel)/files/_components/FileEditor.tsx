"use client";

import * as React from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The inline file editor (CodeMirror 6, per PLAN.md's stack table).
 *
 * Loaded through next/dynamic, so the parser and grammar bundles only
 * arrive when an operator actually opens a file — the manager itself is
 * a table and should not carry a code editor's weight.
 *
 * The highlight style is written against the design tokens rather than
 * CodeMirror's default, which is a light-theme palette and is unreadable
 * on a near-black surface. Colours reuse the semantic ramp on purpose:
 * a string is the same green as "healthy" and an error is the same red
 * as "critical", so nothing new has to be learned to read a config file.
 * ------------------------------------------------------------------ */

const highlight = HighlightStyle.define([
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--kn-text-3)",
    fontStyle: "italic",
  },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.self],
    color: "var(--kn-accent-300)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--kn-ok)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "var(--kn-warn)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--kn-info)" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--kn-accent-400)",
  },
  {
    tag: [tags.typeName, tags.className, tags.tagName, tags.namespace],
    color: "var(--kn-chart-6)",
  },
  {
    tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket],
    color: "var(--kn-text-2)",
  },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: "var(--kn-text)" },
  { tag: [tags.link, tags.url], color: "var(--kn-accent-400)", textDecoration: "underline" },
  { tag: [tags.heading, tags.strong], color: "var(--kn-text)", fontWeight: "500" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--kn-danger)" },
]);

/*
 * `dark: true` picks CodeMirror's dark defaults for the handful of
 * details this block does not override. The panel's light theme still
 * renders correctly because every surface, line and caret colour below
 * is a token that inverts with it.
 */
const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "var(--kn-text)",
      backgroundColor: "var(--kn-bg-inset)",
      fontSize: "12px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--kn-font-mono)", lineHeight: "18px" },
    ".cm-content": { caretColor: "var(--kn-accent-400)", padding: "8px 0" },
    ".cm-gutters": {
      backgroundColor: "var(--kn-bg-inset)",
      color: "var(--kn-text-3)",
      border: "none",
      borderRight: "1px solid var(--kn-border)",
    },
    ".cm-activeLine": { backgroundColor: "var(--kn-surface)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--kn-surface)", color: "var(--kn-text-2)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--kn-accent-400)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--kn-accent-soft-strong)",
    },
    ".cm-selectionMatch": { backgroundColor: "var(--kn-accent-soft)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--kn-accent-soft)",
      outline: "1px solid var(--kn-accent-500)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--kn-accent-soft-strong)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--kn-surface-3)",
      outline: "none",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--kn-surface-3)",
      border: "none",
      color: "var(--kn-text-2)",
    },
    ".cm-panels": {
      backgroundColor: "var(--kn-surface)",
      color: "var(--kn-text)",
      borderColor: "var(--kn-border)",
    },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "var(--kn-surface-2)",
      color: "var(--kn-text)",
      border: "1px solid var(--kn-border)",
      borderRadius: "var(--kn-r-sm)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--kn-surface-2)",
      border: "1px solid var(--kn-border)",
      color: "var(--kn-text)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--kn-surface-3)",
      color: "var(--kn-text)",
    },
  },
  { dark: true },
);

/* ------------------------------ language ----------------------------- */

const LANGUAGES: Record<string, () => LanguageSupport> = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  htm: () => html(),
  vue: () => html(),
  php: () => php(),
  py: () => python(),
  sql: () => sql(),
  yaml: () => yaml(),
  yml: () => yaml(),
};

/** Human name for the status line; "Plain text" is a real answer. */
export const LANGUAGE_LABELS: Record<string, string> = {
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  htm: "HTML",
  vue: "Vue",
  php: "PHP",
  py: "Python",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
};

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function languageLabel(path: string): string {
  return LANGUAGE_LABELS[extensionOf(path)] ?? "Plain text";
}

function languageFor(path: string): Extension {
  const factory = LANGUAGES[extensionOf(path)];
  return factory ? factory() : [];
}

/* ------------------------------- editor ------------------------------ */

export interface FileEditorProps {
  /** Absolute path; drives which grammar is loaded. */
  path: string;
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
  readOnly?: boolean;
  wrap?: boolean;
  className?: string;
}

export function FileEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
  wrap = false,
  className,
}: FileEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const languageRef = React.useRef(new Compartment());
  const editableRef = React.useRef(new Compartment());
  const wrapRef = React.useRef(new Compartment());

  /* Latest-value refs: rebuilding the editor because a parent re-rendered
   * with a fresh callback would throw away the cursor and the undo history. */
  const changeRef = React.useRef(onChange);
  changeRef.current = onChange;
  const saveRef = React.useRef(onSave);
  saveRef.current = onSave;
  /** What we last handed the parent, so its echo is not re-applied. */
  const emittedRef = React.useRef(value);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current();
                return true;
              },
            },
          ]),
          basicSetup,
          syntaxHighlighting(highlight),
          theme,
          languageRef.current.of(languageFor(path)),
          editableRef.current.of(EditorState.readOnly.of(readOnly)),
          wrapRef.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            emittedRef.current = next;
            changeRef.current(next);
          }),
        ],
      }),
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mounted once per opened file: `path` identifies the document, and
    // everything below reconfigures the live view rather than remounting
    // it, because a remount would discard the cursor and the undo stack.
  }, [path]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: languageRef.current.reconfigure(languageFor(path)) });
  }, [path]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapRef.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  /* An external replacement — a reload, a discard — is pushed in as one
   * transaction. The guard is what keeps typing from fighting the prop. */
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || value === emittedRef.current) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    emittedRef.current = value;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn("min-h-0 flex-1 overflow-hidden bg-[var(--kn-bg-inset)]", className)}
    />
  );
}
