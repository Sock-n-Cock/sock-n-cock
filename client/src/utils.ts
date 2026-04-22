export const generateSafeId = (id: string): string => {
  return id.replace(/[^a-z0-9]/gi, '');
};

export const getTrimmedLogs = (newLog: string, currentLogs: string[], maxLogs: number = 15): string[] => {
  const timestamp = new Date().toLocaleTimeString();
  return [`${timestamp} - ${newLog}`, ...currentLogs].slice(0, maxLogs);
};

export const generateUserCredentials = () => ({
  name: `User_${Math.floor(Math.random() * 1000)}`,
  color: `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`
});