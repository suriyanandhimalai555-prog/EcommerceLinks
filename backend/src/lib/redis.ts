import { Redis } from "ioredis";
import { CFG } from "../config.js";

let _redis: Redis | undefined;

export function redis(): Redis {
	if (!_redis) {
		_redis = new Redis(CFG.REDIS_URL, { lazyConnect: true });
		_redis.on("error", (err: Error) => console.error("Redis error", err));
	}
	return _redis;
}
