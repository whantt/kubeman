import k8sFunctions from '../k8s/k8sFunctions'
import {ActionGroupSpec, ActionContextType, 
        ActionOutput, ActionOutputStyle, } from '../actions/actionSpec'
import K8sPluginHelper from '../k8s/k8sPluginHelper'
import {generateServiceComparisonOutput} from './namespaceCompareServices'

const plugin : ActionGroupSpec = {
  context: ActionContextType.Cluster,
  actions: [
    {
      name: "Compare Services",
      order: 5,
      
      choose: K8sPluginHelper.chooseClusters,

      async act(actionContext) {
        const clusters = K8sPluginHelper.getSelectedClusters(actionContext)
        if(clusters.length < 2) {
          actionContext.onOutput && actionContext.onOutput([["Not enough clusters to compare"]], ActionOutputStyle.Text)
          return
        }
        const clusterServices = await k8sFunctions.getServicesGroupedByClusterNamespace(clusters)
        const namespaces: any[] = []
        Object.keys(clusterServices).map(cluster => Object.keys(clusterServices[cluster]))
        .forEach(cnamespaces => cnamespaces.forEach(namespace => 
          namespaces.push({name: namespace})))

        const output: ActionOutput = generateServiceComparisonOutput(clusters, namespaces, clusterServices)
        actionContext.onOutput && actionContext.onOutput(output, ActionOutputStyle.Compare)
      },
    },
  ]
}

export default plugin