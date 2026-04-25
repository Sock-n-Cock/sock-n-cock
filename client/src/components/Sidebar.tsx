import React, { useState, useEffect } from 'react';
import { Users, Wifi, WifiOff, Activity, ChevronDown, ChevronRight, Hash, FileText, Trash2 } from 'lucide-react';
import type { User } from '../types';

interface SidebarProps {
  isConnected: boolean;
  roomUsers: User[];
  currentUserId: string;
  logs: string[];
  docId: string;
  availableDocs: string[];
  onJoinRoom: (newRoomId: string) => void;
  onDeleteDoc: (id: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isConnected, roomUsers, currentUserId, logs, docId, availableDocs, onJoinRoom, onDeleteDoc }) => {
  const [roomInput, setRoomInput] = useState(docId);
  const [isLogsVisible, setIsLogsVisible] = useState(true);

  useEffect(() => { setRoomInput(docId); }, [docId]);

  const handleRoomChange = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomInput.trim() && roomInput !== docId) onJoinRoom(roomInput.trim());
  };

  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <img
          src="/sock-n-cock-logo.png"
          alt=""
          style={{
            width: '24px',
            height: '24px',
            transform: 'scale(2)',
            boxSizing: 'border-box',
            marginRight: '8px',
            objectFit: 'contain'
          }}
        />
        <h2>Sock'n'Cock</h2>
      </div>

      <div className="sidebar-section">
        <form className="room-manager" onSubmit={handleRoomChange}>
          <div className="input-group">
            <Hash size={16} className="input-icon" />
            <input type="text" className="room-input" value={roomInput} onChange={(e) => setRoomInput(e.target.value)} placeholder="Enter or Create Room ID" />
          </div>
          <button type="submit" className="btn-primary">Connect</button>
        </form>
      </div>

      {/* Секция со списком документов из MongoDB */}
      <div className="sidebar-section">
         <div className="section-header">
          <span className="flex-center gap-2">
            <FileText size={16}/> Saved Documents
          </span>
        </div>
        <div className="users-list custom-scrollbar" style={{ marginTop: '8px', maxHeight: '180px', overflowY: 'auto', paddingRight: '4px' }}>
          {availableDocs.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#6b7280' }}>No documents yet</div>
          ) : (
            availableDocs.map(doc => (
              <div
                key={doc}
                className={`user-item ${doc === docId ? 'is-me' : ''}`}
                onClick={() => onJoinRoom(doc)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span className="user-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc}</span>

                {/* Кнопка удаления */}
                <Trash2
                  size={14}
                  style={{ color: '#ef4444', minWidth: '14px', opacity: 0.7 }}
                  onClick={(e) => {
                    e.stopPropagation(); // Чтобы клик не вызывал onJoinRoom
                    onDeleteDoc(doc);
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '0.7'}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <div className="sidebar-section users-section">
        <div className="section-header">
          <span className="flex-center gap-2">
            <Users size={16}/> {roomUsers.length} Online
          </span>
          {isConnected ? <Wifi size={16} className="text-success"/> : <WifiOff size={16} className="text-danger"/>}
        </div>
        <div className="users-list">
          {roomUsers.map(u => (
            <div key={u.id} className={`user-item ${u.id === currentUserId ? 'is-me' : ''}`}>
              <div className="user-dot" style={{ backgroundColor: u.color, boxShadow: `0 0 8px ${u.color}66` }}></div>
              <span className="user-name">{u.name} {u.id === currentUserId && <span className="me-badge">You</span>}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={`logs-panel ${isLogsVisible ? 'expanded' : 'collapsed'}`}>
        <div className="logs-header" onClick={() => setIsLogsVisible(!isLogsVisible)}>
          <span className="flex-center gap-2">
            <Activity size={16}/> System Logs
          </span>
          {isLogsVisible ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        {isLogsVisible && (
          <div className="logs-content">
            {logs.map((l, i) => <div key={i} className="log-entry"><span className="log-bullet">›</span> {l}</div>)}
          </div>
        )}
      </div>
    </div>
  );
};