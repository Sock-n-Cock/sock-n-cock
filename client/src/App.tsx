import { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';

function App() {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#1e1e1e', color: 'white', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <Editor
          theme="vs-dark"
          language="javascript"
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
          }}
          options={{
            fontSize: 15,
            automaticLayout: true,
            cursorSmoothCaretAnimation: 'on',
          }}
        />
      </div>
    </div>
  );
}

export default App;