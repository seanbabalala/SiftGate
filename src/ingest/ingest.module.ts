import { PricingModule } from '../pricing/pricing.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatCompletionsController } from './chat-completions.controller';
import { ResponsesController } from './responses.controller';
import { MessagesController } from './messages.controller';
import { ModelsController } from './models.controller';
import { EmbeddingsController } from './embeddings.controller';
import { RerankController } from './rerank.controller';
import { MediaController } from './media.controller';
import { VideoController } from './video.controller';
import { PlaygroundController } from './playground.controller';
import { PipelineModule } from '../pipeline/pipeline.module';
import { ConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { AgentProfilesModule } from '../agent-profiles/agent-profiles.module';
import { CallLog, RouteDecisionLog, VideoJob } from '../database/entities';

@Module({
  imports: [
    PipelineModule,
    PricingModule,
    ConfigModule,
    AuthModule,
    AgentProfilesModule,
    TypeOrmModule.forFeature([CallLog, RouteDecisionLog, VideoJob]),
  ],
  controllers: [
    ChatCompletionsController,
    ResponsesController,
    MessagesController,
    EmbeddingsController,
    RerankController,
    MediaController,
    VideoController,
    PlaygroundController,
    ModelsController,
  ],
})
export class IngestModule {}
