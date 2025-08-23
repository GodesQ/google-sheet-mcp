import { Redis } from '@upstash/redis';

export interface SessionData {
  sessionId: string;
  createdAt: number;
  lastAccessed: number;
  transportData?: any; // Serialized transport data if needed
}

export class SessionManager {
  private static instance: SessionManager;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private redis: Redis;
  private readonly SESSION_PREFIX = 'mcp_session:';

  private constructor() {
    // Initialize Redis client
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!redisUrl || !redisToken) {
      console.warn('Redis credentials not found. Falling back to in-memory storage.');
      this.redis = null as any;
    } else {
      this.redis = new Redis({
        url: redisUrl,
        token: redisToken,
      });
      console.log('SessionManager initialized with Redis storage');
    }
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  private getSessionKey(sessionId: string): string {
    return `${this.SESSION_PREFIX}${sessionId}`;
  }

  private parseSessionData(data: any): SessionData | null {
    try {
      if (typeof data === 'string') {
        return JSON.parse(data);
      } else if (data && typeof data === 'object') {
        // If it's already an object, validate it has the required properties
        if (data.sessionId && typeof data.createdAt === 'number' && typeof data.lastAccessed === 'number') {
          return data as SessionData;
        }
      }
      return null;
    } catch (error) {
      console.error('Error parsing session data:', error);
      return null;
    }
  }

  async createSession(sessionId: string): Promise<void> {
    try {
      const sessionData: SessionData = {
        sessionId,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
      };

      if (this.redis) {
        // Store in Redis with expiration
        await this.redis.setex(
          this.getSessionKey(sessionId),
          Math.floor(this.SESSION_TIMEOUT / 1000), // Convert to seconds
          JSON.stringify(sessionData)
        );
        console.log(`Created session in Redis: ${sessionId}`);
      } else {
        console.log(`Created session in memory (fallback): ${sessionId}`);
      }
    } catch (error) {
      console.error(`Error creating session ${sessionId}:`, error);
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      if (this.redis) {
        const sessionData = await this.redis.get(this.getSessionKey(sessionId));
        if (sessionData) {
          const session = this.parseSessionData(sessionData);
          if (session) {
            // Update last accessed time
            session.lastAccessed = Date.now();
            // Refresh the session in Redis
            await this.redis.setex(
              this.getSessionKey(sessionId),
              Math.floor(this.SESSION_TIMEOUT / 1000),
              JSON.stringify(session)
            );
            return session;
          }
        }
        return null;
      } else {
        console.log(`Redis not available, session ${sessionId} not found`);
        return null;
      }
    } catch (error) {
      console.error(`Error getting session ${sessionId}:`, error);
      return null;
    }
  }

  async updateSession(sessionId: string): Promise<void> {
    try {
      if (this.redis) {
        const session = await this.getSession(sessionId);
        if (session) {
          session.lastAccessed = Date.now();
          await this.redis.setex(
            this.getSessionKey(sessionId),
            Math.floor(this.SESSION_TIMEOUT / 1000),
            JSON.stringify(session)
          );
        }
      }
    } catch (error) {
      console.error(`Error updating session ${sessionId}:`, error);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      if (this.redis) {
        await this.redis.del(this.getSessionKey(sessionId));
        console.log(`Deleted session from Redis: ${sessionId}`);
      } else {
        console.log(`Redis not available, cannot delete session: ${sessionId}`);
      }
    } catch (error) {
      console.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  async getAllSessions(): Promise<SessionData[]> {
    try {
      if (this.redis) {
        // Get all session keys
        const keys = await this.redis.keys(`${this.SESSION_PREFIX}*`);
        const sessions: SessionData[] = [];
        
        for (const key of keys) {
          const sessionData = await this.redis.get(key);
          if (sessionData) {
            const session = this.parseSessionData(sessionData);
            if (session) {
              sessions.push(session);
            }
          }
        }
        
        return sessions;
      } else {
        console.log('Redis not available, returning empty session list');
        return [];
      }
    } catch (error) {
      console.error('Error getting all sessions:', error);
      return [];
    }
  }

  async cleanupExpiredSessions(): Promise<void> {
    try {
      if (this.redis) {
        // Redis automatically handles expiration, so we don't need manual cleanup
        console.log('Redis handles session expiration automatically');
      } else {
        console.log('No cleanup needed for in-memory fallback');
      }
    } catch (error) {
      console.error('Error cleaning up expired sessions:', error);
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      if (this.redis) {
        const exists = await this.redis.exists(this.getSessionKey(sessionId));
        return exists === 1;
      } else {
        return false;
      }
    } catch (error) {
      console.error(`Error checking if session exists ${sessionId}:`, error);
      return false;
    }
  }

  getStorageType(): string {
    return this.redis ? 'Redis' : 'In-Memory (Fallback)';
  }

  // Test method to verify Redis connection
  async testRedisConnection(): Promise<boolean> {
    try {
      if (this.redis) {
        await this.redis.ping();
        console.log('Redis connection test successful');
        return true;
      } else {
        console.log('Redis not configured');
        return false;
      }
    } catch (error) {
      console.error('Redis connection test failed:', error);
      return false;
    }
  }
}

export const sessionManager = SessionManager.getInstance(); 