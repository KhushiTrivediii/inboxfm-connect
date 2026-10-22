import { azureOpenaiAuth } from '../auth';
import {
    Property,
    StoreScope,
    createAction,
} from '@inboxfm-connect/pieces-framework';
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';
import { calculateMessagesTokenSize, exceedsHistoryLimit, reduceContextSize } from '../common';
import * as z from 'zod/mini'
import { propsValidation } from '@inboxfm-connect/pieces-common';

export const askGpt = createAction({
  audience: 'human',
    auth: azureOpenaiAuth,
    name: 'ask_gpt',
    displayName: 'Ask GPT',
    description: 'Ask ChatGPT anything you want!',
    props: {
        deploymentId: Property.ShortText({
            displayName: 'Deployment Name',
            description: 'The name of your model deployment.',
            required: true,
        }),
        model: Property.StaticDropdown({
            displayName: 'Model',
            description:
                'The model behind the deployment name. Deployment names are arbitrary labels and cannot be resolved to a model with the data-plane API, so this is the only way the context guard can know the real window. Leave empty to keep the legacy conservative (2048-token) history budget.',
            required: false,
            options: {
                options: [
                    { label: 'gpt-4o', value: 'gpt-4o' },
                    { label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
                    { label: 'gpt-4.1', value: 'gpt-4.1' },
                    { label: 'gpt-4.1-mini', value: 'gpt-4.1-mini' },
                    { label: 'gpt-4', value: 'gpt-4' },
                    { label: 'gpt-35-turbo', value: 'gpt-35-turbo' },
                    { label: 'gpt-35-turbo-16k', value: 'gpt-35-turbo-16k' },
                ],
            },
        }),
        prompt: Property.LongText({
            displayName: 'Question',
            required: true,
        }),
        temperature: Property.Number({
            displayName: 'Temperature',
            required: false,
            description:
                'Controls randomness: Lowering results in less random completions. As the temperature approaches zero, the model will become deterministic and repetitive.',
            defaultValue: 0.9,
        }),
        maxTokens: Property.Number({
            displayName: 'Maximum Tokens',
            required: true,
            description:
                "The maximum number of tokens to generate. Requests can use up to 2,048 or 4,096 tokens shared between prompt and completion depending on the model. Don't set the value to maximum and leave some tokens for the input. (One token is roughly 4 characters for normal English text)",
            defaultValue: 2048,
        }),
        topP: Property.Number({
            displayName: 'Top P',
            required: false,
            description:
                'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.',
            defaultValue: 1,
        }),
        frequencyPenalty: Property.Number({
            displayName: 'Frequency penalty',
            required: false,
            description:
                "Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model's likelihood to repeat the same line verbatim.",
            defaultValue: 0,
        }),
        presencePenalty: Property.Number({
            displayName: 'Presence penalty',
            required: false,
            description:
                "Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the mode's likelihood to talk about new topics.",
            defaultValue: 0.6,
        }),
        memoryKey: Property.ShortText({
            displayName: 'Memory Key',
            description:
                'A memory key that will keep the chat history shared across runs and flows. Keep it empty to leave ChatGPT without memory of previous messages.',
            required: false,
        }),
        roles: Property.Json({
            displayName: 'Roles',
            required: false,
            description: 'Array of roles to specify more accurate response',
            defaultValue: [
                { role: 'system', content: 'You are a helpful assistant.' },
            ],
        }),
    },

    async run(context) {
        const { propsValue, store } = context;
        const auth = context.auth.props;

        await propsValidation.validateZod(propsValue, {
            temperature: z.optional(z.number().check(z.minimum(0), z.maximum(1.0))),
            frequencyPenalty: z.optional(z.number().check(z.minimum(-2.0), z.maximum(2.0))),
            presencePenalty: z.optional(z.number().check(z.minimum(-2.0), z.maximum(2.0))),
        });

        const openai = new OpenAIClient(
            auth.endpoint,
            new AzureKeyCredential(auth.apiKey),
            {
                apiVersion: '2024-12-01-preview',
            }
        );

        let messageHistory: any[] | null = [];
        // If memory key is set, retrieve messages stored in history
        if (propsValue.memoryKey) {
            messageHistory = (await store.get(propsValue.memoryKey, StoreScope.PROJECT)) ?? [];
        }

        // Add user prompt to message history
        messageHistory.push({
            role: 'user',
            content: propsValue.prompt,
        });

        // Add system instructions if set by user
        const rolesArray = propsValue.roles ? (propsValue.roles as any) : [];
        const roles = rolesArray.map((item: any) => {
            const rolesEnum = ['system', 'user', 'assistant'];
            if (!rolesEnum.includes(item.role)) {
                throw new Error(
                    'The only available roles are: [system, user, assistant]'
                );
            }

            return {
                role: item.role,
                content: item.content,
            };
        });

        const completionOptions = {
            maxCompletionTokens: propsValue.maxTokens,
            temperature: propsValue.temperature,
            frequencyPenalty: propsValue.frequencyPenalty,
            presencePenalty: propsValue.presencePenalty,
            topP: propsValue.topP,
        };

        const completion = await openai.getChatCompletions(propsValue.deploymentId, [...roles, ...messageHistory], completionOptions);

        const responseText = completion.choices[0].message?.content ?? '';

        // Add response to message history
        // The stored history holds { role, content } objects; appending a bare
        // string would corrupt the shape and be rejected by the API next turn.
        // `content` can be undefined when the model filters the response; fall
        // back to '' so the stored shape stays valid instead of throwing on
        // undefined.length in the estimator next turn.
        messageHistory = [
            ...messageHistory,
            { role: 'assistant', content: responseText ?? '' },
        ];

        // Check message history token size
        // System limit is 32K tokens, we can probably make it bigger but this is a safe spot
        // The roles/system messages are sent on every call ([...roles, ...messageHistory]),
        // so they consume request context the history-only estimate never saw. Include
        // their tokens in the budget and hand the same combined size to reduceContextSize
        // so the reduced history actually fits alongside the system prompt.
        // The model prop lets the guard budget against the deployment's real
        // context window (issue #377); without it we keep the legacy
        // conservative behavior ('' falls back to 2048).
        const model = propsValue.model ?? '';
        const rolesTokenLength = await calculateMessagesTokenSize(roles, model);
        const tokenLength = await calculateMessagesTokenSize(messageHistory, model);
        if (propsValue.memoryKey) {
            // If tokens exceed 90% system limit or 90% of model limit - maxTokens, reduce history token size
            if (exceedsHistoryLimit(tokenLength + rolesTokenLength, model, propsValue.maxTokens)) {
                messageHistory = await reduceContextSize(
                    messageHistory,
                    model,
                    propsValue.maxTokens,
                    rolesTokenLength
                );
            }
            // Store history
            await store.put(propsValue.memoryKey, messageHistory, StoreScope.PROJECT);
        }

        return responseText;
    },
});

