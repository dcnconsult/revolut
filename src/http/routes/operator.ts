import type { FastifyInstance } from 'fastify';
import type { OperatorAuth } from '../../security/operator-auth.js';

interface LoginBody {
  username?: string;
  password?: string;
}

export async function operatorRoutes(app: FastifyInstance, auth: OperatorAuth) {
  app.post<{ Body: LoginBody }>('/operator/session', async (request, reply) => {
    const username = typeof request.body?.username === 'string' ? request.body.username : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const login = auth.login(username, password, request.ip);
    if (!login) return reply.code(401).send({ error: 'Username or password is incorrect.' });
    auth.setSessionCookie(reply, login.rawToken);
    return reply.send(login.principal);
  });

  app.get('/operator/session', async (request, reply) => {
    const principal = auth.authenticate(request);
    if (!principal || principal.role === 'automation') {
      return reply.code(401).send({ error: 'Authentication required.' });
    }
    return reply.send(principal);
  });

  app.delete('/operator/session', async (request, reply) => {
    const principal = auth.require(request, reply, ['admin', 'viewer'], true);
    if (!principal) return;
    auth.logout(request);
    auth.clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
