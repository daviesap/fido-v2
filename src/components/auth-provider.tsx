"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  GoogleAuthProvider,
  getIdTokenResult,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

type AuthValue = {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, async (nextUser) => {
    try {
      if (!nextUser) {
        setUser(null);
        return;
      }
      const token = await getIdTokenResult(nextUser, true);
      if (token.claims.fidoOwner !== true) {
        await firebaseSignOut(auth);
        throw new Error("This account exists, but it has not been marked as Fido’s owner yet.");
      }
      setUser(nextUser);
      setError(null);
    } catch (authError) {
      setUser(null);
      setError(authError instanceof Error ? authError.message : "Sign-in failed.");
    } finally {
      setLoading(false);
    }
  }), []);

  const signIn = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Sign-in failed.");
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
  }, []);

  const value = useMemo(() => ({ user, loading, error, signIn, signOut }), [user, loading, error, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
