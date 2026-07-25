import { useState, type FormEvent } from 'react';
import type { AuthView } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

interface AuthScreenProps {
  view: AuthView;
  bootstrapOpen: boolean;
  loading: boolean;
  error: string;
  onViewChange(view: AuthView): void;
  onLogin(identifier: string, password: string): Promise<void>;
  onRegister(username: string, email: string, password: string): Promise<void>;
}

export function AuthScreen(props: AuthScreenProps) {
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.view === 'login') void props.onLogin(identifier, password);
    else void props.onRegister(username, email, password);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{props.view === 'login' ? 'Sign in' : 'Create administrator'}</CardTitle>
          <CardDescription>Manage Tweets-2-Bsky with a secure cookie session.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            {props.view === 'login' ? (
              <div><Label htmlFor="auth-identifier">Username or email</Label><Input id="auth-identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required /></div>
            ) : (
              <>
                <div><Label htmlFor="auth-username">Username</Label><Input id="auth-username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
                <div><Label htmlFor="auth-email">Email</Label><Input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
              </>
            )}
            <div><Label htmlFor="auth-password">Password</Label><Input id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
            {props.error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{props.error}</p> : null}
            <Button className="w-full" type="submit" disabled={props.loading}>{props.loading ? 'Please wait…' : props.view === 'login' ? 'Sign in' : 'Register'}</Button>
          </form>
          {props.bootstrapOpen ? <Button className="mt-3 w-full" variant="ghost" onClick={() => props.onViewChange(props.view === 'login' ? 'register' : 'login')}>{props.view === 'login' ? 'Create the first administrator' : 'Back to sign in'}</Button> : null}
        </CardContent>
      </Card>
    </main>
  );
}
