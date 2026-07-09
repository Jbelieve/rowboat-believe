import { z } from "zod";
import { IProjectsRepository } from "../../repositories/projects.repository.interface";
import { IProjectActionAuthorizationPolicy } from "../../policies/project-action-authorization.policy";
import { IUsageQuotaPolicy } from "../../policies/usage-quota.policy.interface";
import { ComposioConnectedAccount } from "@/src/entities/models/project";
import { listAuthConfigs, createAuthConfig, linkConnectedAccount } from "@/src/application/lib/composio/composio";
import { ZCreateConnectedAccountResponse } from "../../lib/composio/types";
import { ZCreateAuthConfigResponse } from "../../lib/composio/types";
import { ZAuthScheme } from "../../lib/composio/types";

export const InputSchema = z.object({
    caller: z.enum(["user", "api"]),
    userId: z.string().optional(),
    apiKey: z.string().optional(),
    projectId: z.string(),
    toolkitSlug: z.string(),
    callbackUrl: z.string(),
});

export interface ICreateComposioManagedConnectedAccountUseCase {
    execute(request: z.infer<typeof InputSchema>): Promise<z.infer<typeof ZCreateConnectedAccountResponse>>;
}

export class CreateComposioManagedConnectedAccountUseCase implements ICreateComposioManagedConnectedAccountUseCase {
    private readonly projectsRepository: IProjectsRepository;
    private readonly projectActionAuthorizationPolicy: IProjectActionAuthorizationPolicy;
    private readonly usageQuotaPolicy: IUsageQuotaPolicy;

    constructor({
        projectsRepository,
        projectActionAuthorizationPolicy,
        usageQuotaPolicy,
    }: {
        projectsRepository: IProjectsRepository,
        projectActionAuthorizationPolicy: IProjectActionAuthorizationPolicy,
        usageQuotaPolicy: IUsageQuotaPolicy,
    }) {
        this.projectsRepository = projectsRepository;
        this.projectActionAuthorizationPolicy = projectActionAuthorizationPolicy;
        this.usageQuotaPolicy = usageQuotaPolicy;
    }

    async execute(request: z.infer<typeof InputSchema>): Promise<z.infer<typeof ZCreateConnectedAccountResponse>> {
        const { caller, userId, apiKey, projectId, toolkitSlug, callbackUrl } = request;

        await this.projectActionAuthorizationPolicy.authorize({ caller, userId, apiKey, projectId });
        await this.usageQuotaPolicy.assertAndConsumeProjectAction(projectId);

        // fetch managed auth configs
        const configs = await listAuthConfigs(toolkitSlug, null, true);

        // check if managed oauth2 config exists or create one
        let authConfigId: string | undefined = undefined;
        const managedOauth2 = configs.items.find(cfg => cfg.auth_scheme === 'OAUTH2' && cfg.is_composio_managed);
        if (managedOauth2) {
            authConfigId = managedOauth2.id;
        } else {
            const created: z.infer<typeof ZCreateAuthConfigResponse> = await createAuthConfig({
                toolkit: { slug: toolkitSlug },
                auth_config: {
                    type: 'use_composio_managed_auth',
                    name: 'composio-managed-oauth2',
                },
            });
            authConfigId = created.auth_config.id;
        }

        if (!authConfigId) {
            throw new Error(`No managed oauth2 auth config found for toolkit ${toolkitSlug}`);
        }

        // initiate managed-OAuth connection via the /connected_accounts/link endpoint
        // (the plain /connected_accounts endpoint no longer supports composio-managed configs)
        const link = await linkConnectedAccount({
            auth_config_id: authConfigId,
            user_id: projectId,
            callback_url: callbackUrl,
        });

        // map the link response into the shape the UI expects (id + connectionData.val.redirectUrl)
        const response: z.infer<typeof ZCreateConnectedAccountResponse> = {
            id: link.connected_account_id,
            connectionData: {
                authScheme: 'OAUTH2',
                val: {
                    status: 'INITIATED',
                    redirectUrl: link.redirect_url,
                },
            },
        };

        // persist to project
        const now = new Date().toISOString();
        const account: z.infer<typeof ComposioConnectedAccount> = {
            id: response.id,
            authConfigId,
            status: 'INITIATED',
            createdAt: now,
            lastUpdatedAt: now,
        };

        await this.projectsRepository.addComposioConnectedAccount(projectId, {
            toolkitSlug,
            data: account,
        });

        return response;
    }
}


