import { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';

function App() {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  return (
    <div style={{ height: '100vh' }}>
      <Editor
        height="100%"
        defaultLanguage="javascript"
        theme="vs-dark"
        onMount={(editor) => { editorRef.current = editor; }}
      />
    </div>
  );
}

export default App;