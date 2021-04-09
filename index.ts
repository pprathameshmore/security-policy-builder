import path from 'path';
import * as assets from './src/assets';
import * as configure from './src/configure';
import * as render from './src/render';
import { PolicyBuilderConfig, PolicyBuilderPaths } from './src/types';

const defaultPaths: PolicyBuilderPaths = {
  partials: 'partials',
  templates: 'templates',
  output: 'docs',
};

export async function policybuilder(
  configuration: PolicyBuilderConfig,
  paths = defaultPaths
) {
  configure.mergeAutomaticPSPVars(configuration);

  // marshal static assets for mkdocs
  await assets.copyStaticAssets(paths);
  await assets.downloadCustomLogo(configuration, paths);
  await render.renderMkdocsYAML(
    configuration,
    paths,
    path.join(paths.output, 'mkdocs.yml')
  );
  await render.renderIndexPage(
    configuration,
    paths,
    path.join(paths.output, 'index.md')
  );

  // render partials and docs
  const renderedPartials = await render.renderPartials(configuration, paths);
  const renderedPSPDocs = await render.renderPSPDocs(configuration, paths);
  return { renderedPartials, renderedPSPDocs };
}
