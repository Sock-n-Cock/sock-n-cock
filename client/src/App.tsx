import { useRef, useState, useEffect } from 'react';
import { io } from "socket.io-client";
import Editor, { type OnMount } from '@monaco-editor/react';
import { editor } from 'monaco-editor';
import { Users, Wifi, WifiOff, Activity } from 'lucide-react';

const DOC_ID = 'main-room';
const USER_NAME = `User_${Math.floor(Math.random() * 1000)}`;
const USER_COLOR = `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`;

const socket = io('ws://localhost:3001', {
  transports: ['websocket'],
  autoConnect: true,
  reconnection: true,
});

type User = {
  id: string;
  name: string;
  color: string;
};

type RemoteCursorData = {
  userId: string;
  name: string;
  color: string;
  selection: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    positionLineNumber: number;
    positionColumn: number;
  };
};

function App() {
  const editorRef = useRef<Parameters<OnMount>[0]>(null);
  const monacoRef = useRef<Parameters<OnMount>[1]>(null);

  const decorationsRef = useRef<Record<string, string[]>>({});
  const isApplyingRemote = useRef<boolean>(false);

  const [logs, setLogs] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [roomUsers, setRoomUsers] = useState<User[]>([]);

  const addLog = (msg : string) => setLogs(prev => [`${new Date().toLocaleTimeString()} - ${msg}`, ...prev].slice(0, 15));

  const removeUserDecorations = (userId : string) => {
    if (editorRef.current && decorationsRef.current[userId]) {
      editorRef.current.deltaDecorations(decorationsRef.current[userId], []);
      delete decorationsRef.current[userId];

      const safeId = userId.replace(/[^a-z0-9]/gi, '');
      const styleTag = document.getElementById(`style-${safeId}`);
      if (styleTag) styleTag.remove();
    }
  };

  const handleEditorChange = (_value: string | undefined, event: { changes: editor.IModelContentChange[]; }) => {
    if (isApplyingRemote.current || !socket.connected) return;
    event.changes.forEach(change => {
      socket.emit('client-op', {
        docId: DOC_ID,
        text: change.text,
        range: change.range,
      });
    });
  };

  const updateRemoteCursor = (data: RemoteCursorData) => {
    const { userId, selection, name, color } = data;

    if (!editorRef.current || !monacoRef.current || !selection) return;

    const safeId = userId.replace(/[^a-z0-9]/gi, '');
    const newDecorations = [];

    if (selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn) {
      newDecorations.push({
        range: new monacoRef.current.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        ),
        options: {
          className: `remote-selection-${safeId}`,
        }
      });
    }

    newDecorations.push({
      range: new monacoRef.current.Range(
        selection.positionLineNumber,
        selection.positionColumn,
        selection.positionLineNumber,
        selection.positionColumn
      ),
      options: {
        className: `remote-cursor-${safeId}`,
        stickiness: monacoRef.current.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    });

    if (!document.getElementById(`style-${safeId}`)) {
      const style = document.createElement('style');
      style.id = `style-${safeId}`;
      style.innerHTML = `
        .remote-cursor-${safeId} {
          border-left: 2px solid ${color} !important;
          margin-left: -1px;
          position: relative;
          z-index: 10;
          border-right: 4px solid transparent;
        }

        .remote-cursor-${safeId}::before {
          content: '${name}';
          position: absolute;
          top: -20px;
          left: -2px;
          background: ${color};
          color: white;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
          z-index: 1000;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease-in-out;
          font-family: sans-serif;
          box-shadow: 0px 2px 4px rgba(0,0,0,0.2);
        }

        .remote-cursor-${safeId}:hover::before {
          opacity: 1;
        }

        .remote-selection-${safeId} {
          background-color: ${color}40 !important;
        }
      `;
      document.head.appendChild(style);
    }

    decorationsRef.current[userId] = editorRef.current.deltaDecorations(
      decorationsRef.current[userId] || [],
      newDecorations
    );
  };

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      addLog('Connected to server');
      socket.emit('join', { docId: DOC_ID, userName: USER_NAME, color: USER_COLOR });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      addLog('Disconnected from server');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    socket.on('users-changed', (users : User[]) => {
      setRoomUsers(users);
      const activeIds = users.map((u : User) => u.id);
      Object.keys(decorationsRef.current).forEach(id => {
        if (!activeIds.includes(id) && id !== socket.id) {
          removeUserDecorations(id);
        }
      });
    });

    socket.on('user-left', (userId : string) => {
      removeUserDecorations(userId);
      addLog(`User left: ${userId.slice(0, 4)}`);
    });

    socket.on('server-update', (op) => {
      if (op.userId === socket.id || !editorRef.current) return;

      const model = editorRef.current.getModel();
      if (!model) return;

      isApplyingRemote.current = true;
      model.applyEdits([{
        range: op.range,
        text: op.text,
        forceMoveMarkers: true
      }]);
      isApplyingRemote.current = false;
      addLog(`Remote edit: ${op.userId.slice(0, 4)}`);
    });

    socket.on('remote-cursor', (data) => {
      updateRemoteCursor(data);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('users-changed');
      socket.off('user-left');
      socket.off('server-update');
      socket.off('remote-cursor');
    };
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#1e1e1e', color: 'white', overflow: 'hidden' }}>
      <div style={{ width: '260px', borderRight: '1px solid #333', padding: '15px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={20}/> People
          </h3>
          {isConnected ? <Wifi size={18} color="#4caf50"/> : <WifiOff size={18} color="#f44336"/>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {roomUsers.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', color: u.id === socket.id ? '#fff' : '#ccc' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: u.color }}></div>
              <span style={{ fontSize: '14px' }}>{u.name} {u.id === socket.id ? '(You)' : ''}</span>
            </div>
          ))}
        </div>
        <div style={{ height: '200px', borderTop: '1px solid #333', paddingTop: '10px' }}>
          <h3 style={{ fontSize: '14px', color: '#888', display: 'flex', alignItems: 'center', gap: '8px' }}><Activity size={16}/> Logs</h3>
          <div style={{ fontSize: '11px', color: '#666', height: '160px', overflowY: 'auto', fontFamily: 'monospace' }}>
            {logs.map((l, i) => <div key={i} style={{ padding: '2px 0' }}>{l}</div>)}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <Editor
          theme="vs-dark"
          language="javascript"
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;

            editor.onDidChangeCursorSelection((e) => {
              if (!socket.connected) return;
              socket.emit('cursor-move', {
                docId: DOC_ID,
                selection: e.selection,
                name: USER_NAME,
                color: USER_COLOR
              });
            });
          }}
          onChange={handleEditorChange}
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