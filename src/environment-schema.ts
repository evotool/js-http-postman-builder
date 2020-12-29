export function buildEnvironment(name: string, environments: { [key: string]: string }): PostmanEnvironmentSchema {
	const environmentSchema: PostmanEnvironmentSchema = {
		name,
		values: Object
			.entries(environments)
			.map(([key, value]) => ({
				key,
				value,
				enabled: true,
			})),
	};

	return environmentSchema;
}

export interface PostmanEnvironmentSchema {
	id?: string;
	name: string;
	values: {
		key: string;
		value: string;
		enabled: boolean;
	}[];
}
