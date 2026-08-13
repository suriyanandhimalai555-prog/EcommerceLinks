import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
	interface FastifyInstance {
		authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
		requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
		/** Allows management and payout roles — used on the 7 withdrawal-marking
		 *  routes. Keeps payout out of every other /admin/* route. */
		requireWithdrawalStaff(request: FastifyRequest, reply: FastifyReply): Promise<void>;
	}
}
