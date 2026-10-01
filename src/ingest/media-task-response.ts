import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gatewayApiKeyFromRequest } from "../auth/gateway-api-key-metadata";
import type { MediaTaskService } from "../pricing/media-task.service";
import {
  PublicGatewayError,
  sendMappedPublicErrorResponse,
} from "../http/public-error-handling";
import {
  GATEWAY_REQUEST_ID_HEADER,
  sendPublicResponse,
} from "../http/public-contract";

/** Returns false only when the scoped task does not exist (legacy video may then be consulted). */
export async function sendMediaTaskResponse(
  tasks: MediaTaskService,
  kind: "video" | "image",
  action: "status" | "cancel" | "content",
  id: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  let requestId: string | undefined;
  try {
    const task = await tasks.findOwned(id, gatewayApiKeyFromRequest(req), kind);
    if (!task) return false;
    requestId = task.request_id;
    if (action === "content") {
      const upstream = await tasks.content(task);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new PublicGatewayError(
          "Media content delivery failed; incurred generation costs are unchanged",
          { statusCode: 502, code: "media_content_unavailable" },
        );
      }
      res.setHeader(GATEWAY_REQUEST_ID_HEADER, task.request_id);
      res.setHeader("x-request-id", task.request_id);
      res.setHeader("x-correlation-id", task.request_id);
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
      );
      if (upstream.body)
        await pipeline(
          Readable.fromWeb(
            upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
          ),
          res,
        );
      else res.end();
      return true;
    }
    let refreshStatus = "current";
    if (action === "cancel") await tasks.cancel(task);
    else {
      try {
        await tasks.refresh(task);
      } catch {
        refreshStatus = "unavailable";
      }
    }
    const current = await tasks.get(task.id, task.workspace_id);
    sendPublicResponse(res, {
      statusCode: 200,
      requestId,
      body: {
        ...(await tasks.publicView(current ?? task)),
        refresh_status: refreshStatus,
      },
    });
  } catch (error) {
    if (!res.headersSent)
      sendMappedPublicErrorResponse(res, req, error, { requestId });
    else res.destroy();
  }
  return true;
}
