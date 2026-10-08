'use client';

import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror, { EditorSelection, EditorView, type Extension, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef, useState } from 'react';

/** Language name (as returned by the repository API) → CodeMirror language support. */
function languageExtension(lang: string): Extension[] {
  switch (lang) {
    case 'typescript':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'javascript':
      return [javascript()];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'json':
      return [json()];
    case 'markdown':
      return [markdown()];
    case 'css':
    case 'scss':
      return [css()];
    case 'html':
    case 'vue':
    case 'svelte':
    case 'xml':
      return [html()];
    case 'yaml':
      return [yaml()];
    case 'php':
      return [php()];
    case 'python':
      return [python()];
    case 'sql':
      return [sql()];
    default:
      return [];
  }
}

function useDarkTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => {
      const t = document.documentElement.dataset.theme;
      setDark(t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', read);
    };
  }, []);
  return dark;
}

export function CodeEditor({
  value,
  language,
  readOnly,
  onChange,
  line,
  onCursor,
}: {
  value: string;
  language: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  /** 1-based line to reveal and select when the file opens. */
  line?: number | null;
  onCursor?: (line: number, col: number) => void;
}) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const dark = useDarkTheme();
  const extensions = useMemo(
    () => [
      ...languageExtension(language),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet && onCursor) {
          const head = u.state.selection.main.head;
          const l = u.state.doc.lineAt(head);
          onCursor(l.number, head - l.from + 1);
        }
      }),
    ],
    [language, onCursor],
  );

  useEffect(() => {
    const view = ref.current?.view;
    if (!view || !line) return;
    const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({ selection: EditorSelection.range(target.from, target.to), effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
  }, [line]);

  return (
    <CodeMirror
      ref={ref}
      value={value}
      height="100%"
      theme={dark ? oneDark : 'light'}
      extensions={extensions}
      readOnly={readOnly}
      editable={!readOnly}
      onChange={onChange}
      basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: !readOnly }}
      onCreateEditor={(view) => {
        if (!line) return;
        const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
        view.dispatch({ selection: EditorSelection.range(target.from, target.to), effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
      }}
    />
  );
}
