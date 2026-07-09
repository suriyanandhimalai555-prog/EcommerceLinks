import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
	interface FastifyInstance {
		authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
		requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
	}
}
