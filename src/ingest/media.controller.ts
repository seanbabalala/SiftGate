import { MediaTaskService } from '../pricing/media-task.service';
import { sendMediaTaskResponse } from './media-task-response';
import { sendPublicErrorResponse } from '../http/public-contract';
import { Controller, Get, Param, Post, Req, Res, Logger, UseGuards, Optional } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { MediaNormalizer } from '../canonical/normalizers/media.normalizer';
import { CanonicalMediaSourceFormat } from '../canonical/canonical.types';
import { PipelineService, PipelineResult } from '../pipeline/pipeline.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import {
  attachGatewayApiKeyMetadata,
  gatewayApiKeyFromRequest,
} from '../auth/gateway-api-key-metadata';
import {
  sendMappedPublicErrorResponse,
  sendPublicResponse,
} from '../http/public-error-handling';
import {
  AudioSpeechRequestDto,
  AudioTranscriptionRequestDto,
  AudioTranslationRequestDto,
  ErrorEnvelopeDto,
  ImageEditRequestDto,
  ImageGenerationRequestDto,
  ImageVariationRequestDto,
} from '../openapi/openapi.dto';

@Controller('v1')
@UseGuards(ApiKeyGuard, RateLimitGuard)
@ApiTags('AI Proxy')
@ApiBearerAuth('gatewayApiKey')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);
  private readonly normalizer = new MediaNormalizer();

  constructor(private readonly pipeline: PipelineService, @Optional() private readonly mediaTasks?: MediaTaskService) {}

  @Get('images/jobs/:id')
  async getImageJob(@Param('id') id: string, @Req() req: Request, @Res() res: Response) { await this.imageTask('status', id, req, res); }

  @Post('images/jobs/:id/cancel')
  async cancelImageJob(@Param('id') id: string, @Req() req: Request, @Res() res: Response) { await this.imageTask('cancel', id, req, res); }

  @Get('images/jobs/:id/content')
  async imageJobContent(@Param('id') id: string, @Req() req: Request, @Res() res: Response) { await this.imageTask('content', id, req, res); }

  private async imageTask(action: 'status' | 'cancel' | 'content', id: string, req: Request, res: Response): Promise<void> {
    if (this.mediaTasks && await sendMediaTaskResponse(this.mediaTasks, 'image', action, id, req, res)) return;
    sendPublicErrorResponse(res, 404, 'openai', 'Image job not found', { type: 'not_found' });
  }

  @Post('images/generations')
  @ApiOperation({
    summary: 'OpenAI Images generation compatible ingress',
    description: 'Passes OpenAI-compatible image generation requests through SiftGate image-capable nodes.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: ImageGenerationRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible image generation response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async imageGenerations(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'image_generation');
  }

  @Post('images/edits')
  @ApiOperation({
    summary: 'OpenAI Images edits compatible ingress',
    description: 'Passes OpenAI-compatible image edit requests through SiftGate image-capable nodes. Payload bytes pass through unchanged. Enabled pricing may inspect bounded PCM WAV headers; it does not retain media contents.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: ImageEditRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible image edit response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async imageEdits(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'image_edit');
  }

  @Post('images/variations')
  @ApiOperation({
    summary: 'OpenAI Images variations compatible ingress',
    description: 'Passes OpenAI-compatible image variation requests through SiftGate image-capable nodes. Payload bytes pass through unchanged. Enabled pricing may inspect bounded PCM WAV headers; it does not retain media contents.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: ImageVariationRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible image variation response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async imageVariations(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'image_variation');
  }

  @Post('audio/transcriptions')
  @ApiOperation({
    summary: 'OpenAI Audio transcription compatible ingress',
    description: 'Passes OpenAI-compatible audio transcription requests through SiftGate audio-capable nodes. Payload bytes pass through unchanged. Enabled pricing may inspect bounded PCM WAV headers; it does not retain media contents.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: AudioTranscriptionRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible transcription response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async audioTranscriptions(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'audio_transcription');
  }

  @Post('audio/translations')
  @ApiOperation({
    summary: 'OpenAI Audio translation compatible ingress',
    description: 'Passes OpenAI-compatible audio translation requests through SiftGate audio-capable nodes. Payload bytes pass through unchanged. Enabled pricing may inspect bounded PCM WAV headers; it does not retain media contents.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ type: AudioTranslationRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible translation response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async audioTranslations(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'audio_translation');
  }

  @Post('audio/speech')
  @ApiOperation({
    summary: 'OpenAI Audio speech compatible ingress',
    description: 'Passes OpenAI-compatible text-to-speech requests through SiftGate audio-capable nodes. Binary audio responses are streamed back as returned by the provider.',
  })
  @ApiConsumes('application/json')
  @ApiBody({ type: AudioSpeechRequestDto })
  @ApiOkResponse({ description: 'OpenAI-compatible speech audio or JSON response.' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto })
  async audioSpeech(@Req() req: Request, @Res() res: Response) {
    await this.handleMedia(req, res, 'audio_speech');
  }

  private async handleMedia(
    req: Request,
    res: Response,
    sourceFormat: CanonicalMediaSourceFormat,
  ): Promise<void> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    const abortOnResponseClose = () => {
      if (!res.writableEnded) abort();
    };
    req.on?.('aborted', abort);
    res.on?.('close', abortOnResponseClose);

    try {
      const headers = this.extractHeaders(req);
      const canonical = this.normalizer.normalize(req.body, headers, sourceFormat);
      this.applyGatewayKey(req, canonical);

      this.logger.log(
        `[${this.sourcePath(sourceFormat)}] model=${canonical.model || 'auto'}, ` +
          `operation=${canonical.media.operation}, multipart=${canonical.is_multipart}, ` +
          `files=${canonical.media.file_count}, bytes=${canonical.media.byte_size}`,
      );

      const result = await this.pipeline.processMedia(canonical, {
        signal: abortController.signal,
      });
      this.sendPipelineResult(res, result);
    } catch (err) {
      this.logger.error(`[${this.sourcePath(sourceFormat)}] Error: ${(err as Error).message}`);
      if (!res.headersSent) {
        sendMappedPublicErrorResponse(res, req, err);
      }
    } finally {
      req.off?.('aborted', abort);
      res.off?.('close', abortOnResponseClose);
    }
  }

  private applyGatewayKey(
    req: Request,
    canonical: ReturnType<MediaNormalizer['normalize']>,
  ): void {
    attachGatewayApiKeyMetadata(canonical, gatewayApiKeyFromRequest(req));
  }

  private sendPipelineResult(res: Response, result: PipelineResult): void {
    sendPublicResponse(res, result);
  }

  private sourcePath(sourceFormat: CanonicalMediaSourceFormat): string {
    switch (sourceFormat) {
      case 'image_generation':
        return 'images/generations';
      case 'image_edit':
        return 'images/edits';
      case 'image_variation':
        return 'images/variations';
      case 'audio_transcription':
        return 'audio/transcriptions';
      case 'audio_translation':
        return 'audio/translations';
      case 'audio_speech':
        return 'audio/speech';
      default:
        return sourceFormat;
    }
  }

  private extractHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    return headers;
  }
}
