export interface SessionData {
  sessionId: string;
  createdAt: number;
  lastAccessed: number;
  transportData?: any; // Serialized transport data if needed
}

export class SessionManager {
  private static instance: SessionManager;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private inMemorySessions: Map<string, SessionData> = new Map();

  private constructor() {
    console.log('SessionManager initialized with in-memory storage');
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  async createSession(sessionId: string): Promise<void> {
    const sessionData: SessionData = {
      sessionId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
    };

    this.inMemorySessions.set(sessionId, sessionData);
    console.log(`Created session in memory: ${sessionId}`);
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const session = this.inMemorySessions.get(sessionId);
      if (session) {
        // Update last accessed time
        session.lastAccessed = Date.now();
        this.inMemorySessions.set(sessionId, session);
        return session;
      }
      return null;
    } catch (error) {
      console.error(`Error getting session ${sessionId}:`, error);
      return null;
    }
  }

  async updateSession(sessionId: string): Promise<void> {
    try {
      const session = await this.getSession(sessionId);
      if (session) {
        session.lastAccessed = Date.now();
        this.inMemorySessions.set(sessionId, session);
      }
    } catch (error) {
      console.error(`Error updating session ${sessionId}:`, error);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      this.inMemorySessions.delete(sessionId);
      console.log(`Deleted session from memory: ${sessionId}`);
    } catch (error) {
      console.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  async getAllSessions(): Promise<SessionData[]> {
    try {
      return Array.from(this.inMemorySessions.values());
    } catch (error) {
      console.error('Error getting all sessions:', error);
      return [];
    }
  }

  async cleanupExpiredSessions(): Promise<void> {
    try {
      const sessions = await this.getAllSessions();
      const now = Date.now();
      
      for (const session of sessions) {
        if (now - session.lastAccessed > this.SESSION_TIMEOUT) {
          await this.deleteSession(session.sessionId);
        }
      }
    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
    }
  }

  getStorageType(): string {
    return 'In-Memory';
  }
}

export const sessionManager = SessionManager.getInstance(); 