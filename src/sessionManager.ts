import { Redis } from '@upstash/redis';

// Initialize Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

export interface SessionData {
  sessionId: string;
  createdAt: number;
  lastAccessed: number;
  transportData?: any; // Serialized transport data if needed
}

export class SessionManager {
  private static instance: SessionManager;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  private constructor() {}

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

    await redis.setex(`session:${sessionId}`, this.SESSION_TIMEOUT / 1000, JSON.stringify(sessionData));
    console.log(`Created session in Redis: ${sessionId}`);
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const sessionData = await redis.get(`session:${sessionId}`);
      if (sessionData) {
        const session = JSON.parse(sessionData as string) as SessionData;
        // Update last accessed time
        session.lastAccessed = Date.now();
        await redis.setex(`session:${sessionId}`, this.SESSION_TIMEOUT / 1000, JSON.stringify(session));
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
        await redis.setex(`session:${sessionId}`, this.SESSION_TIMEOUT / 1000, JSON.stringify(session));
      }
    } catch (error) {
      console.error(`Error updating session ${sessionId}:`, error);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await redis.del(`session:${sessionId}`);
      console.log(`Deleted session from Redis: ${sessionId}`);
    } catch (error) {
      console.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  async getAllSessions(): Promise<SessionData[]> {
    try {
      const keys = await redis.keys('session:*');
      const sessions: SessionData[] = [];
      
      for (const key of keys) {
        const sessionData = await redis.get(key);
        if (sessionData) {
          sessions.push(JSON.parse(sessionData as string));
        }
      }
      
      return sessions;
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
}

export const sessionManager = SessionManager.getInstance();
